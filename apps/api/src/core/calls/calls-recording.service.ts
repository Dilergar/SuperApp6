import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CallRecording, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { EgressStatus, type WebhookEvent } from 'livekit-server-sdk';
import type { CallRecordingDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { FilesService } from '../files/files.service';
import { CallsLivekitClient } from './calls-livekit.client';
import { CallsRefRegistry } from './calls-ref.registry';
import { CallsRecordingRegistry } from './calls-recording.registry';
import { JobContext, JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';

/** Статусы «запись ещё идёт/финализируется» (partial unique в БД покрывает эти же) */
const ACTIVE_RECORDING_STATUSES = ['recording', 'processing', 'ingesting'] as const;
const MAX_FINALIZE_ATTEMPTS = 5;

/** Типы джобов подсистемы записи в реестре core/jobs. */
const FINALIZE_JOB = 'calls.recording.finalize';
const DELIVER_JOB = 'calls.recording.deliver';

/**
 * Подсистема записи движка звонков (LiveKit Egress, всегда аудио → OGG):
 *  ⏺ start (любой УЧАСТНИК созвона; одна активная запись на сессию — partial unique)
 *  ⏹ stop (инициатор записи ∨ модератор по резолверу refType)
 *  «Получить запись» claim (участник; после финализации клеймант получает файл
 *  через хук потребителя CallsRecordingRegistry — Диктофон кладёт в «Журнал звонков»)
 *
 * Финализация — вебхук egress_ended: атомарный клейм статуса → ingestLocalFile
 * (копия, исходник не потребляется) → status='ready' → доставка клеймов. Гонка
 * «клейм vs финализация» закрыта порядком операций: claim-эндпоинт СНАЧАЛА пишет
 * клейм и лишь потом читает статус; финализация СНАЧАЛА ставит ready и лишь потом
 * читает клеймы — интерливинг «оба пропустили» невозможен, страховка — крон.
 */
@Injectable()
export class CallsRecordingService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(CallsRecordingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly livekit: CallsLivekitClient,
    private readonly refRegistry: CallsRefRegistry,
    private readonly recordingRegistry: CallsRecordingRegistry,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
  ) {}

  onModuleInit(): void {
    // Джобы записи есть только при включённой записи (LIVEKIT_EGRESS_DIR) — иначе
    // строки CallRecording не создаются и джобы не ставятся (паттерн scanHook/voice).
    if (!this.livekit.recordingEnabled) return;
    this.jobsRegistry.register(
      FINALIZE_JOB,
      (payload, ctx) => this.handleFinalizeJob(String(payload.recordingId), payload, ctx),
      {
        maxAttempts: MAX_FINALIZE_ATTEMPTS,
        leaseMs: 15 * 60 * 1000,
        onDiscard: (payload, info) =>
          this.markRecordingDiscarded(String(payload.recordingId), info.error),
      },
    );
    this.jobsRegistry.register(
      DELIVER_JOB,
      (payload) => this.handleDeliverJob(String(payload.recordingId), String(payload.userId)),
      { maxAttempts: 8 },
    );
  }

  onApplicationBootstrap(): void {
    if (!this.livekit.recordingEnabled) return;
    void this.backfillRecordingJobs().catch((err) =>
      this.logger.warn(`recording backfill failed: ${String((err as Error)?.message ?? err)}`),
    );
  }

  /**
   * Поставить джоб финализации (uniqueKey `cr:<id>`, дедуп среди живых). Вебхук/крон
   * приносят снимок egress (complete+containerFile) в payload; бэкфилл ставит без него —
   * тогда обработчик сам опросит LiveKit (getEgressInfo).
   */
  private async enqueueFinalize(
    recordingId: string,
    egress?: { complete: boolean; containerFile: string | null; error: string | null },
  ): Promise<void> {
    await this.jobs.enqueue(null, {
      type: FINALIZE_JOB,
      payload: { recordingId, ...(egress ? egress : {}) },
      uniqueKey: `cr:${recordingId}`,
    });
  }

  /**
   * Джоб финализации похоронен. Важно для смерти ПО АРЕНДЕ (краш/зависание): обработчик
   * тогда не отрабатывал, и запись осталась бы в ingesting — «● Запись» горит вечно,
   * partial-unique блокирует новую запись сессии, инициатор не знает о провале.
   */
  private async markRecordingDiscarded(recordingId: string, error: string): Promise<void> {
    const rec = await this.db.callRecording.findUnique({ where: { id: recordingId } });
    if (!rec || rec.status === 'ready' || rec.status === 'error') return;
    await this.markError(rec, `финализация не удалась: ${error}`);
  }

  /** Поставить джоб доставки записи одному клейманту (uniqueKey `crd:<id>:<user>`). */
  private async enqueueDeliver(tx: Prisma.TransactionClient | null, recordingId: string, userId: string): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: DELIVER_JOB,
      payload: { recordingId, userId },
      uniqueKey: `crd:${recordingId}:${userId}`,
    });
  }

  // ============================================================
  // REST-операции (участник звонка)
  // ============================================================

  async start(userId: string, sessionId: string): Promise<CallRecordingDto> {
    if (!this.livekit.recordingEnabled) {
      throw new BadRequestException('Запись звонков не подключена (LIVEKIT_EGRESS_DIR не задан)');
    }
    const session = await this.requireActiveSession(sessionId);
    // Нет потребителя-доставщика для этого refType (напр. офис Ф3 ещё не подключён) —
    // не даём начать: иначе запись финализируется, но джоб доставки некому исполнить
    // (хук refType не зарегистрирован), файл повиснет неотданным — проверяем на входе.
    if (!this.recordingRegistry.get(session.refType)) {
      throw new BadRequestException('Запись для этого типа звонка пока не поддерживается');
    }
    await this.requireParticipant(sessionId, userId, { openOnly: true });

    let rec: CallRecording;
    try {
      rec = await this.db.callRecording.create({
        data: {
          sessionId,
          refType: session.refType,
          refId: session.refId,
          workspaceId: session.workspaceId,
          startedById: userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Запись уже идёт');
      }
      throw err;
    }
    // Инициатор — первый клеймант (запись попадёт в его «Журнал звонков» автоматически)
    await this.addClaim(rec.id, userId);

    try {
      const info = await this.livekit.startAudioEgress(session.roomName, `${rec.id}-${randomUUID().slice(0, 8)}.ogg`);
      // Status-guard: пока StartEgress висел, крон-редрайв мог пометить строку error
      // (см. ветку «egress не стартовал»). Тогда egressId писать НЕЛЬЗЯ — гасим egress,
      // иначе он пишет комнату скрытно (индикатор «● Запись» смотрит только 'recording').
      const claimed = await this.db.callRecording.updateMany({
        where: { id: rec.id, status: 'recording' },
        data: { egressId: info.egressId },
      });
      if (claimed.count !== 1) {
        await this.livekit.stopEgress(info.egressId);
        throw new ConflictException('Запись уже остановлена');
      }
      rec = (await this.db.callRecording.findUnique({ where: { id: rec.id } })) ?? rec;
    } catch (err) {
      // Слот освобождаем (error вне partial unique) — «запись идёт» не должно врать
      await this.db.callRecording.update({
        where: { id: rec.id },
        data: { status: 'error', error: 'egress не стартовал', endedAt: new Date() },
      }).catch(() => undefined);
      throw err;
    }

    this.events.emit('call.recording.started', this.eventPayload(rec), 'calls');
    return this.serialize(rec, true);
  }

  async stop(userId: string, sessionId: string): Promise<CallRecordingDto> {
    const rec = await this.db.callRecording.findFirst({
      where: { sessionId, status: 'recording' },
      orderBy: { startedAt: 'desc' },
    });
    if (!rec) throw new NotFoundException('Идущая запись не найдена');
    if (rec.startedById !== userId) {
      const resolver = this.refRegistry.get(rec.refType);
      if (!resolver || !(await resolver.canModerate(userId, rec.refId))) {
        throw new ForbiddenException('Остановить запись может её инициатор или модератор');
      }
    }
    const claimed = await this.db.callRecording.updateMany({
      where: { id: rec.id, status: 'recording' },
      data: { status: 'processing' },
    });
    if (claimed.count === 1 && rec.egressId) await this.livekit.stopEgress(rec.egressId);
    this.events.emit('call.recording.stopped', this.eventPayload(rec), 'calls');
    const fresh = await this.db.callRecording.findUnique({ where: { id: rec.id } });
    return this.serialize(fresh ?? rec, await this.isClaimed(rec.id, userId));
  }

  /**
   * «Получить запись»: клеймант получает ПОЛНУЮ запись в свой Диктофон после
   * финализации. Порядок против гонки: (1) insert claim → (2) читать статус →
   * (3) ready — доставить сразу.
   */
  async claim(userId: string, sessionId: string): Promise<CallRecordingDto> {
    const rec = await this.db.callRecording.findFirst({
      where: { sessionId, status: { not: 'error' } },
      orderBy: { startedAt: 'desc' },
    });
    if (!rec) throw new NotFoundException('Запись этого звонка не найдена');

    // Доступ перепроверяем СЕЙЧАС резолвером refType (как issueToken на каждый вход):
    // историческая строка журнала звонок обходит Hard Revoke — снятый с задачи/уволенный
    // не должен забрать запись по сохранённому sessionId.
    const resolver = this.refRegistry.get(rec.refType);
    if (!resolver || !(await resolver.canJoin(userId, rec.refId))) {
      throw new ForbiddenException('Нет доступа к этому звонку');
    }
    // Окно присутствия: забрать запись может лишь тот, чьё присутствие в комнате
    // пересекалось с окном записи [startedAt, endedAt] — не «был когда-то в звонке до
    // начала записи». Инициатор клеймится в start() отдельно (он всегда внутри окна).
    await this.requirePresenceDuringRecording(sessionId, userId, rec.startedAt, rec.endedAt);

    await this.addClaim(rec.id, userId);
    // Джоб доставки ставим ВСЕГДА, а не только на ready: финализация может коммитить
    // ready прямо сейчас — её транзакция нашего клейма ещё не видит, а мы её ready ещё
    // не видим, и тогда клеймant остался бы без доставки. Обработчик сам дождётся ready.
    await this.enqueueDeliver(null, rec.id, userId);
    const fresh = await this.db.callRecording.findUnique({ where: { id: rec.id } });
    return this.serialize(fresh ?? rec, true);
  }

  /** Флаг «идёт запись» для снимков activeCall (батч по сессиям) */
  async recordingSessionIds(sessionIds: string[]): Promise<Set<string>> {
    if (!sessionIds.length) return new Set();
    const rows = await this.db.callRecording.findMany({
      where: { sessionId: { in: sessionIds }, status: 'recording' },
      select: { sessionId: true },
    });
    return new Set(rows.map((r) => r.sessionId));
  }

  // ============================================================
  // Вебхук egress_* (at-least-once → идемпотентно; evt.room может отсутствовать)
  // ============================================================

  async handleEgressEvent(evt: WebhookEvent): Promise<void> {
    const info = evt.egressInfo;
    if (!info?.egressId) return;
    if (evt.event !== 'egress_ended') return; // started/updated — статус ведём сами
    const rec = await this.db.callRecording.findUnique({ where: { egressId: info.egressId } });
    if (!rec) {
      this.logger.warn(`egress_ended для незнакомого egress ${info.egressId} — игнор`);
      return;
    }
    // Ставим джоб финализации со СНИМКОМ egress из вебхука (обработчик LiveKit не опрашивает
    // на этом пути — результат уже пришёл). Дубль вебхука → тот же uniqueKey → no-op.
    await this.enqueueFinalize(rec.id, {
      complete: info.status === EgressStatus.EGRESS_COMPLETE,
      containerFile: info.fileResults?.[0]?.filename ?? null,
      error: info.error ?? null,
    });
  }

  /**
   * Обработчик джоба `calls.recording.finalize`: снимок egress из payload (вебхук/крон)
   * или самоопрос LiveKit (бэкфилл) → клейм ingesting (токен attempts) → файл egress
   * в core/files → ready + джобы доставки в одной tx. Транзиентная ошибка → ретрай движка,
   * терминальная (egress не COMPLETE / исчерпание попыток) → error.
   */
  private async handleFinalizeJob(
    recordingId: string,
    payload: Record<string, unknown>,
    ctx: JobContext,
  ): Promise<void> {
    const rec = await this.db.callRecording.findUnique({ where: { id: recordingId } });
    if (!rec) return; // строка удалена
    if (rec.status === 'ready' || rec.status === 'error') return; // терминал → no-op
    if (!rec.egressId) {
      await this.markError(rec, 'egress не стартовал');
      throw new JobDiscardError(`recording ${recordingId}: egress не стартовал`);
    }

    // Снимок egress: из payload (вебхук/крон) либо самоопрос LiveKit (бэкфилл после рестарта).
    let complete = typeof payload.complete === 'boolean' ? (payload.complete as boolean) : undefined;
    let containerFile = (payload.containerFile as string | null | undefined) ?? null;
    let egressError = (payload.error as string | null | undefined) ?? null;
    if (complete === undefined) {
      const info = await this.livekit.getEgressInfo(rec.egressId);
      if (!info) throw new Error(`egress ${rec.egressId} не найден в LiveKit`);
      if (
        info.status === EgressStatus.EGRESS_ACTIVE ||
        info.status === EgressStatus.EGRESS_STARTING ||
        info.status === EgressStatus.EGRESS_ENDING
      ) {
        throw new Error(`egress ещё активен (${EgressStatus[info.status] ?? info.status})`);
      }
      complete = info.status === EgressStatus.EGRESS_COMPLETE;
      containerFile = info.fileResults?.[0]?.filename ?? null;
      egressError = info.error ?? null;
    }

    if (!complete) {
      await this.markError(rec, `egress не завершился: ${egressError || 'без деталей'}`);
      throw new JobDiscardError(`recording ${recordingId}: egress не COMPLETE`);
    }

    // Клейм в ingesting + МОНОТОННЫЙ токен строки. НЕ ctx.attempt: у нового джоба того же
    // recording'а ctx.attempt снова начинается с 1, и сравнение с накопленным attempts
    // навсегда блокировало бы клейм — запись «залипала» бы в ingesting без единого шанса.
    // Токен нужен только чтобы отставший (зомби) заход не затёр финал более свежего.
    const claimed = await this.db.callRecording.updateMany({
      where: { id: rec.id, status: { in: [...ACTIVE_RECORDING_STATUSES] } },
      data: { status: 'ingesting', attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return; // уже ready/error
    const token =
      (await this.db.callRecording.findUnique({ where: { id: rec.id }, select: { attempts: true } }))
        ?.attempts ?? 0;

    try {
      if (!containerFile) throw new Error('egress не вернул файл');
      const hostDir = this.livekit.egressDir;
      if (!hostDir) throw new Error('LIVEKIT_EGRESS_DIR не задан');
      const hostPath = path.join(hostDir, path.basename(containerFile));
      // access ДО ingest: файл ещё не сброшен на диск → бросаем без сироты в files
      await fs.promises.access(hostPath, fs.constants.R_OK);

      const started = rec.startedAt;
      const title = `Звонок · ${started.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${started.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      const file = await this.files.ingestLocalFile({
        path: hostPath,
        name: `${title}.ogg`,
        mime: 'audio/ogg',
        profile: 'dictaphone',
        ownerUserId: rec.startedById,
      });

      // ready + постановка джобов доставки — в одной транзакции (outbox): либо запись
      // готова и доставки поставлены, либо (проигранная гонка на клейме) откат без сирот.
      const readied = await this.db.$transaction(async (tx) => {
        const done = await tx.callRecording.updateMany({
          where: { id: rec.id, status: 'ingesting', attempts: token },
          data: { status: 'ready', fileId: file.id, endedAt: new Date(), error: null },
        });
        if (done.count !== 1) return false;
        const claims = await tx.callRecordingClaim.findMany({
          where: { recordingId: rec.id, deliveredAt: null },
          select: { userId: true },
        });
        for (const c of claims) await this.enqueueDeliver(tx, rec.id, c.userId);
        return true;
      });
      if (!readied) return; // более новый заход уже финализировал

      await fs.promises.unlink(hostPath).catch(() => undefined);
      const fresh = await this.db.callRecording.findUnique({ where: { id: rec.id } });
      if (fresh) this.events.emit('call.recording.ready', this.eventPayload(fresh), 'calls');
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.logger.warn(`финализация записи ${rec.id} (попытка ${ctx.attempt}/${ctx.maxAttempts}): ${msg}`);
      // На последней попытке — терминальный error (инициатору уйдёт уведомление), затем
      // бросаем (dead-letter). Иначе бросаем → бэкофф-ретрай (строка остаётся ingesting).
      if (ctx.attempt >= ctx.maxAttempts) {
        await this.markError(rec, `финализация не удалась: ${msg}`);
      }
      throw err;
    }
  }

  /** Терминальная ошибка: слот освобождён, инициатору — уведомление */
  private async markError(rec: CallRecording, message: string): Promise<void> {
    const done = await this.db.callRecording.updateMany({
      where: { id: rec.id, status: { in: [...ACTIVE_RECORDING_STATUSES] } },
      data: { status: 'error', error: message.slice(0, 500), endedAt: new Date() },
    });
    if (done.count !== 1) return;
    this.events.emit('call.recording.failed', this.eventPayload(rec), 'calls');
    await this.notifications
      .notify(rec.startedById, 'call.recording.failed', {}, { actionUrl: null })
      .catch(() => undefined);
  }

  /**
   * Обработчик джоба `calls.recording.deliver`: доставка ОДНОМУ клейманту через хук
   * потребителя (идемпотентно — deliveredAt + @@unique у Диктофона). Не ready → ретрай
   * (дозреет); клейм снят → discard; ошибка хука → ретрай движка.
   */
  private async handleDeliverJob(recordingId: string, userId: string): Promise<void> {
    const rec = await this.db.callRecording.findUnique({ where: { id: recordingId } });
    if (!rec) {
      // Запись удалена (каскад сессии) — ретраить нечего и незачем поднимать инцидент.
      throw new JobDiscardError(`recording ${recordingId} удалён — доставка отменена`);
    }
    if (rec.status === 'error') {
      throw new JobDiscardError(`recording ${recordingId} в ошибке — доставлять нечего`);
    }
    if (rec.status !== 'ready' || !rec.fileId) {
      // Финализация ещё идёт — вернём джоб в очередь (бэкофф), дозреет.
      throw new Error(`recording ${recordingId}: ещё не ready — доставка отложена`);
    }
    const claim = await this.db.callRecordingClaim.findFirst({ where: { recordingId, userId } });
    if (!claim) throw new JobDiscardError(`claim ${recordingId}/${userId} снят — доставлять нечего`);
    if (claim.deliveredAt) return; // уже доставлено (идемпотентность)

    const handler = this.recordingRegistry.get(rec.refType);
    if (!handler) {
      // Хук потребителя ещё не зарегистрирован / refType не подключён — ретрай движка.
      throw new Error(`нет recording-хука для refType="${rec.refType}"`);
    }
    await handler.onReady({
      recordingId: rec.id,
      sessionId: rec.sessionId,
      refType: rec.refType,
      refId: rec.refId,
      fileId: rec.fileId,
      startedById: rec.startedById,
      startedAt: rec.startedAt,
      claimantUserId: userId,
    });
    await this.db.callRecordingClaim.updateMany({
      where: { id: claim.id, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
  }

  // ============================================================
  // Крон-редрайв (под Redis-локом вызывающего CallsCron)
  // ============================================================

  async redrive(): Promise<void> {
    const now = Date.now();
    // Подстраховка от потерянного egress_ended: записи, застрявшие в recording/processing
    // без свежих событий, — опрашиваем egress сами и, если он завершился, ставим джоб
    // финализации (дедуп по uniqueKey с вебхуком). Зависший ingesting и недоставленные
    // клеймы теперь ведёт сам движок джобов (аренда/ретраи/бэкофф). Плюс уборка сирот каталога.
    const stale = await this.db.callRecording.findMany({
      where: {
        status: { in: ['recording', 'processing'] },
        updatedAt: { lt: new Date(now - 2 * 60_000) },
      },
      take: 20,
    });
    for (const rec of stale) {
      try {
        if (!rec.egressId) {
          await this.markError(rec, 'egress не стартовал');
          continue;
        }
        const info = await this.livekit.getEgressInfo(rec.egressId);
        if (!info) {
          // LiveKit не знает такой egress (перезапуск / истёк info). Недолго терпим, но
          // висеть вечно нельзя: индикатор «● Запись» горит и partial-unique блокирует
          // новую запись сессии. По порогу — терминальная ошибка с уведомлением.
          if (+rec.updatedAt < now - 30 * 60_000) await this.markError(rec, 'egress пропал');
          continue;
        }
        if (
          info.status === EgressStatus.EGRESS_ACTIVE ||
          info.status === EgressStatus.EGRESS_STARTING ||
          info.status === EgressStatus.EGRESS_ENDING
        ) {
          continue; // живой длинный egress — не трогаем
        }
        await this.enqueueFinalize(rec.id, {
          complete: info.status === EgressStatus.EGRESS_COMPLETE,
          containerFile: info.fileResults?.[0]?.filename ?? null,
          error: info.error ?? null,
        });
      } catch (err) {
        this.logger.warn(`redrive записи ${rec.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // (сироты в egress-каталоге старше суток — файлы, чью финализацию добить не удалось)
    await this.sweepEgressDir();
  }

  /**
   * Бэкфилл при старте: незавершённые записи (инстанс упал в процессе) → джоб финализации
   * БЕЗ снимка egress (обработчик сам опросит LiveKit); ready-записи с недоставленными
   * клеймами → джоб доставки на каждого. uniqueKey дедупит с живыми джобами.
   */
  private async backfillRecordingJobs(): Promise<void> {
    const pending = await this.db.callRecording.findMany({
      where: { status: { in: [...ACTIVE_RECORDING_STATUSES] } },
      take: 200,
      select: { id: true },
    });
    for (const r of pending) await this.enqueueFinalize(r.id);

    const readyUndelivered = await this.db.callRecording.findMany({
      where: { status: 'ready', fileId: { not: null }, claims: { some: { deliveredAt: null } } },
      take: 200,
      select: { id: true, claims: { where: { deliveredAt: null }, select: { userId: true } } },
    });
    let deliver = 0;
    for (const rec of readyUndelivered) {
      for (const c of rec.claims) {
        await this.enqueueDeliver(null, rec.id, c.userId);
        deliver++;
      }
    }
    if (pending.length || deliver) {
      this.logger.log(`recording backfill: ${pending.length} finalize + ${deliver} deliver`);
    }
  }

  private async sweepEgressDir(): Promise<void> {
    const dir = this.livekit.egressDir;
    if (!dir) return;
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - 24 * 3600_000;
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const st = await fs.promises.stat(p);
        if (st.isFile() && st.mtimeMs < cutoff) await fs.promises.unlink(p);
      } catch {
        /* параллельное удаление — не страшно */
      }
    }
  }

  // ---------- helpers ----------

  private async requireActiveSession(sessionId: string) {
    const session = await this.db.callSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'active') {
      throw new NotFoundException('Активная сессия звонка не найдена');
    }
    return session;
  }

  private async requireParticipant(
    sessionId: string,
    userId: string,
    opts: { openOnly: boolean },
  ): Promise<void> {
    const row = await this.db.callSessionParticipant.findFirst({
      where: { sessionId, userId, ...(opts.openOnly ? { leftAt: null } : {}) },
      select: { id: true },
    });
    if (!row) throw new ForbiddenException('Действие доступно только участнику звонка');
  }

  /**
   * Присутствие пользователя пересекалось с окном записи [recStart, recEnd?]. Строка
   * журнала [joinedAt, leftAt?] пересекает окно, если joinedAt ≤ recEnd И
   * (leftAt IS NULL ∨ leftAt ≥ recStart). recEnd=null (запись ещё идёт) → верхняя
   * граница = now (условие по recEnd отпадает).
   */
  private async requirePresenceDuringRecording(
    sessionId: string,
    userId: string,
    recStart: Date,
    recEnd: Date | null,
  ): Promise<void> {
    const overlaps = await this.db.callSessionParticipant.findFirst({
      where: {
        sessionId,
        userId,
        ...(recEnd ? { joinedAt: { lte: recEnd } } : {}),
        OR: [{ leftAt: null }, { leftAt: { gte: recStart } }],
      },
      select: { id: true },
    });
    if (!overlaps) {
      throw new ForbiddenException('Запись доступна только тем, кто был в звонке во время записи');
    }
  }

  private async addClaim(recordingId: string, userId: string): Promise<void> {
    try {
      await this.db.callRecordingClaim.create({ data: { recordingId, userId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }

  private async isClaimed(recordingId: string, userId: string): Promise<boolean> {
    const row = await this.db.callRecordingClaim.findFirst({
      where: { recordingId, userId },
      select: { id: true },
    });
    return !!row;
  }

  private eventPayload(rec: CallRecording): Record<string, unknown> {
    return {
      recordingId: rec.id,
      sessionId: rec.sessionId,
      refType: rec.refType,
      refId: rec.refId,
      workspaceId: rec.workspaceId,
      startedById: rec.startedById,
    };
  }

  private serialize(rec: CallRecording, claimed: boolean): CallRecordingDto {
    return {
      id: rec.id,
      sessionId: rec.sessionId,
      status: rec.status as CallRecordingDto['status'],
      startedById: rec.startedById,
      startedAt: rec.startedAt.toISOString(),
      claimed,
    };
  }
}
