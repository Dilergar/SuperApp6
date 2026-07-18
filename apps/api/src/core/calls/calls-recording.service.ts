import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CallRecording, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { EgressStatus, type EgressInfo, type WebhookEvent } from 'livekit-server-sdk';
import type { CallRecordingDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { FilesService } from '../files/files.service';
import { CallsLivekitClient } from './calls-livekit.client';
import { CallsRefRegistry } from './calls-ref.registry';
import { CallsRecordingRegistry } from './calls-recording.registry';

/** Статусы «запись ещё идёт/финализируется» (partial unique в БД покрывает эти же) */
const ACTIVE_RECORDING_STATUSES = ['recording', 'processing', 'ingesting'] as const;
const MAX_FINALIZE_ATTEMPTS = 5;

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
export class CallsRecordingService {
  private readonly logger = new Logger(CallsRecordingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly livekit: CallsLivekitClient,
    private readonly refRegistry: CallsRefRegistry,
    private readonly recordingRegistry: CallsRecordingRegistry,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
  ) {}

  // ============================================================
  // REST-операции (участник звонка)
  // ============================================================

  async start(userId: string, sessionId: string): Promise<CallRecordingDto> {
    if (!this.livekit.recordingEnabled) {
      throw new BadRequestException('Запись звонков не подключена (LIVEKIT_EGRESS_DIR не задан)');
    }
    const session = await this.requireActiveSession(sessionId);
    // Нет потребителя-доставщика для этого refType (напр. офис Ф3 ещё не подключён) —
    // не даём начать: иначе запись финализируется, но никому не доставится (deliverClaims
    // пометит доставленной), файл повиснет сиротой и сгинет кроном — скрытая потеря.
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
    const fresh = await this.db.callRecording.findUnique({ where: { id: rec.id } });
    if (fresh?.status === 'ready' && fresh.fileId) await this.deliverClaims(fresh);
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
    // Атомарный клейм финализации: дубль вебхука/параллельный редрайв крона отпадает
    const claimed = await this.db.callRecording.updateMany({
      where: { id: rec.id, status: { in: ['recording', 'processing'] } },
      data: { status: 'ingesting' },
    });
    if (claimed.count !== 1) return;
    await this.finalize(rec.id, info);
  }

  /**
   * Финализация: файл egress → core/files → ready → доставка клеймов. Ошибка
   * (файл ещё не доехал/ФС) → возврат в processing + attempts, добьёт крон.
   */
  private async finalize(recordingId: string, info: EgressInfo): Promise<void> {
    const rec = await this.db.callRecording.findUnique({ where: { id: recordingId } });
    if (!rec || rec.status !== 'ingesting') return;

    if (info.status !== EgressStatus.EGRESS_COMPLETE) {
      await this.markError(rec, `egress ${EgressStatus[info.status] ?? info.status}: ${info.error || 'без деталей'}`);
      return;
    }

    try {
      const container = info.fileResults?.[0]?.filename;
      if (!container) throw new Error('egress не вернул файл');
      const hostDir = this.livekit.egressDir;
      if (!hostDir) throw new Error('LIVEKIT_EGRESS_DIR не задан');
      const hostPath = path.join(hostDir, path.basename(container));
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

      const done = await this.db.callRecording.updateMany({
        where: { id: rec.id, status: 'ingesting' },
        data: { status: 'ready', fileId: file.id, endedAt: new Date(), error: null },
      });
      if (done.count !== 1) return;
      await fs.promises.unlink(hostPath).catch(() => undefined);

      const fresh = await this.db.callRecording.findUnique({ where: { id: rec.id } });
      if (fresh) {
        this.events.emit('call.recording.ready', this.eventPayload(fresh), 'calls');
        // Порядок против гонки с claim: ready УЖЕ записан — теперь читаем клеймы
        await this.deliverClaims(fresh);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`финализация записи ${rec.id}: ${msg}`);
      const attempts = rec.attempts + 1;
      if (attempts >= MAX_FINALIZE_ATTEMPTS) {
        await this.markError(rec, `финализация не удалась: ${msg}`);
      } else {
        await this.db.callRecording.updateMany({
          where: { id: rec.id, status: 'ingesting' },
          data: { status: 'processing', error: msg, attempts },
        });
      }
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
   * Доставка недоставленных клеймов через хук потребителя (синхронно, идемпотентно —
   * у Диктофона @@unique([callRecordingId, ownerId])). Сбой одного клейма не
   * блокирует остальных; хвосты редрайвит крон.
   */
  async deliverClaims(rec: CallRecording): Promise<void> {
    if (rec.status !== 'ready' || !rec.fileId) return;
    const handler = this.recordingRegistry.get(rec.refType);
    if (!handler) {
      // Хука нет (регистрация потребителя ещё не выполнена / refType не подключён): НЕ
      // помечаем доставленным — иначе запись теряется навсегда. Крон доретраит, когда
      // хук появится (а start() теперь вообще не пускает запись без хука).
      this.logger.warn(`нет recording-хука для refType="${rec.refType}" — доставка отложена`);
      return;
    }
    const claims = await this.db.callRecordingClaim.findMany({
      where: { recordingId: rec.id, deliveredAt: null },
    });
    for (const claim of claims) {
      try {
        await handler.onReady({
          recordingId: rec.id,
          sessionId: rec.sessionId,
          refType: rec.refType,
          refId: rec.refId,
          fileId: rec.fileId,
          startedById: rec.startedById,
          startedAt: rec.startedAt,
          claimantUserId: claim.userId,
        });
        await this.db.callRecordingClaim.update({
          where: { id: claim.id },
          data: { deliveredAt: new Date() },
        });
      } catch (err) {
        this.logger.warn(
          `доставка записи ${rec.id} клейманту ${claim.userId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // ============================================================
  // Крон-редрайв (под Redis-локом вызывающего CallsCron)
  // ============================================================

  async redrive(): Promise<void> {
    const now = Date.now();
    // (а) зависший ingesting >15 мин — клейм умер посреди финализации → вернуть processing.
    // Порог держим ЗАВЕДОМО больше любого реального инжеста (копия+sha256 даже часового
    // OGG — секунды-минуты), иначе живой инжест преемптится и создаёт ВТОРОЙ файл с
    // повторным списанием квоты. attempts++ на каждый переклейм → не вечный цикл.
    const stuckIngesting = await this.db.callRecording.findMany({
      where: { status: 'ingesting', updatedAt: { lt: new Date(now - 15 * 60_000) } },
      take: 20,
    });
    for (const rec of stuckIngesting) {
      if (rec.attempts + 1 >= MAX_FINALIZE_ATTEMPTS) {
        await this.markError(rec, 'финализация зависла (превышены попытки)');
      } else {
        await this.db.callRecording.updateMany({
          where: { id: rec.id, status: 'ingesting' },
          data: { status: 'processing', attempts: { increment: 1 } },
        });
      }
    }

    // (б) recording/processing без свежих событий >2 мин — спросить egress сами
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
          if (rec.attempts + 1 >= MAX_FINALIZE_ATTEMPTS) await this.markError(rec, 'egress пропал');
          else await this.db.callRecording.update({ where: { id: rec.id }, data: { attempts: { increment: 1 } } });
          continue;
        }
        if (info.status === EgressStatus.EGRESS_ACTIVE || info.status === EgressStatus.EGRESS_STARTING || info.status === EgressStatus.EGRESS_ENDING) {
          continue; // живой длинный egress — не трогаем
        }
        const claimed = await this.db.callRecording.updateMany({
          where: { id: rec.id, status: { in: ['recording', 'processing'] } },
          data: { status: 'ingesting' },
        });
        if (claimed.count === 1) await this.finalize(rec.id, info);
      } catch (err) {
        this.logger.warn(`redrive записи ${rec.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // (в) ready с недоставленными клеймами (потребитель падал в момент доставки)
    const undelivered = await this.db.callRecording.findMany({
      where: { status: 'ready', claims: { some: { deliveredAt: null } } },
      take: 20,
    });
    for (const rec of undelivered) await this.deliverClaims(rec);

    // (г) сироты в egress-каталоге старше суток (файлы, чью финализацию добить не удалось)
    await this.sweepEgressDir();
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
