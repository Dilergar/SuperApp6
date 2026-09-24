import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, VoiceRecording } from '@prisma/client';
import {
  CreateRecordingInput,
  FileDto,
  RECORDER_LIMITS,
  VoiceLanguage,
  VoiceRecordingDto,
  VoiceRecordingSource,
  VoiceRecordingTrashItem,
  VoiceTranscriptStatus,
} from '@superapp/shared';
import { coerceLocale, type Locale } from '@superapp/i18n';
import { badRequest, forbidden, notFound } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { VoiceService } from '../../core/voice/voice.service';
import {
  CallsRecordingRegistry,
  type CallRecordingReadyContext,
} from '../../core/calls/calls-recording.registry';
import { NotificationsService } from '../../core/notifications/notifications.service';
import { decodeCursor, encodeCursor } from '@superapp/shared';

/** Курсор корзины для раннера сроков: (deletedAt, id) — общий кодек платформы */
const REC_TRASH_CURSOR = { d: 'date', i: 'uuid' } as const;

/** Минимум, из которого собирается автоимя записи (строка целиком не нужна). */
export interface AutoTitleRow {
  title: string | null;
  source: string;
  titleAt: Date | null;
  createdAt: Date;
}

/**
 * Диктофон — потребитель голосового движка (прото-Plaud без железки): запись
 * собрания/лекции → транскрипт со спикерами. Файл привязан FileLink'ом
 * refType='voice_recording' (owner-only; без привязки файл приберёт orphan-sweep).
 * Транскрипция и статусы — через API движка VoiceService (в таблицы core/voice
 * напрямую не ходим); файловые связи — через API движка files.
 * Будущие источники: SuperTerminal6 (source='terminal'), запись звонков LiveKit.
 */
@Injectable()
export class RecorderService implements OnModuleInit {
  private readonly logger = new Logger(RecorderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly voice: VoiceService,
    private readonly callsRecordings: CallsRecordingRegistry,
    private readonly notifications: NotificationsService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.filesRegistry.register(
      'voice_recording',
      {
        canView: async (viewerId, refId) => {
          const rec = await this.db.voiceRecording.findUnique({ where: { id: refId }, select: { ownerId: true } });
          return rec?.ownerId === viewerId;
        },
        canAttach: async (userId, refId) => {
          const rec = await this.db.voiceRecording.findUnique({ where: { id: refId, deletedAt: null }, select: { ownerId: true } });
          return rec?.ownerId === userId;
        },
      },
      { allowedProfiles: ['dictaphone', 'voice_message'] },
    );

    // «Журнал звонков»: движок звонков зовёт хук на КАЖДОГО клейманта готовой
    // записи (refType='chat' — звонки мессенджера). Файл ОБЩИЙ (владелец —
    // включивший запись), у каждого клейманта своя VoiceRecording → общий транскрипт.
    this.callsRecordings.register('chat', {
      onReady: (ctx) => this.deliverCallRecording(ctx),
    });
  }

  /**
   * Идемпотентная доставка записи звонка клейманту. Идемпотентность держится на
   * @@unique([callRecordingId, ownerId]) + на НАЛИЧИИ привязанного файла: P2002 сам по
   * себе НЕ значит «доставлено» — прошлая попытка могла упасть между create и linkFile
   * (строка без файла = пустая карточка в «Журнале звонков»). Поэтому на дубль
   * перечитываем строку и до-линковываем файл, если его ещё нет.
   */
  private async deliverCallRecording(ctx: CallRecordingReadyContext): Promise<void> {
    let row: VoiceRecording | null = null;
    try {
      row = await this.db.voiceRecording.create({
        data: {
          ownerId: ctx.claimantUserId,
          // Имени нет: его соберёт чтение в языке зрителя. Момент — НАЧАЛО звонка.
          title: null,
          titleAt: ctx.startedAt,
          source: 'call',
          callRecordingId: ctx.recordingId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        row = await this.db.voiceRecording.findUnique({
          where: { callRecordingId_ownerId: { callRecordingId: ctx.recordingId, ownerId: ctx.claimantUserId } },
        });
      } else {
        throw err;
      }
    }
    if (!row) return; // не смогли ни создать, ни найти — крон доретраит

    // Файл уже привязан? (успешная прошлая доставка) — тогда доставка завершена.
    const linked = await this.files.getLinkedFileIds('voice_recording', row.id);
    if (linked.length) return;

    const created = row;
    try {
      // system: файл ЧУЖОЙ (принадлежит включившему запись), а забирает его каждый
      // клеймант — право проверил движок звонков (участие в сессии), гейт привязки —
      // canAttach резолвера voice_recording (владелец строки = клеймант). Это
      // единственный обоснованный обход правила «привязываю только свой файл».
      await this.files.linkFile(ctx.claimantUserId, ctx.fileId, 'voice_recording', created.id, 'attachment', {
        system: true,
      });
    } catch (err) {
      // Компенсация: строка без файла бессмысленна; клейм останется недоставленным — крон доретраит
      await this.db.voiceRecording.delete({ where: { id: created.id } }).catch(() => undefined);
      throw err;
    }
    await this.notifications
      .send(null, {
        type: 'call.recording.ready',
        to: [{ userId: ctx.claimantUserId }],
        payload: {
          title: await this.titleFor(ctx.claimantUserId, row),
          recordingId: row.id,
          fileId: ctx.fileId,
        },
        ref: { type: 'voice_recording', id: row.id },
        reason: 'owner',
        actionUrl: `/recorder?id=${row.id}`,
        idempotencyKey: `callrec:ready:${row.id}`,
      })
      .catch((err) =>
        this.logger.warn(`notify call.recording.ready: ${err instanceof Error ? err.message : err}`),
      );
  }

  /** Список записей владельца (новые сверху; объём Диктофона мал — без курсора в v1) */
  async list(userId: string): Promise<VoiceRecordingDto[]> {
    const rows = await this.db.voiceRecording.findMany({
      where: { ownerId: userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.serializeMany(rows);
  }

  /** Строки → DTO пачкой: файлы и статусы транскриптов одним запросом на всех. */
  private async serializeMany(rows: VoiceRecording[]): Promise<VoiceRecordingDto[]> {
    if (!rows.length) return [];
    const filesByRec = await this.files.listLinked('voice_recording', rows.map((r) => r.id));
    const fileIds: string[] = [];
    for (const list of filesByRec.values()) for (const f of list) fileIds.push(f.id);
    const transcriptByFile = await this.voice.getStatusesForFiles(fileIds);
    return rows.map((r) => {
      const file = filesByRec.get(r.id)?.[0] ?? null;
      const tr = file ? transcriptByFile.get(file.id) ?? null : null;
      return this.serialize(r, file, tr?.status ?? null, tr?.durationMs ?? null);
    });
  }

  async create(userId: string, input: CreateRecordingInput): Promise<VoiceRecordingDto> {
    const [file] = await this.files.getOwnedReadyFiles(userId, [input.fileId]);
    if (file.kind !== 'audio') throw badRequest('recorder.audioOnly');

    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.voiceRecording.create({
        data: {
          ownerId: userId,
          // Имя ввели руками — храним; не ввели — собирается при чтении
          title: input.title ?? null,
          source: input.source ?? 'upload',
          language: input.language ?? null,
        },
      });
      await this.files.linkManyInTx(tx, userId, [input.fileId], 'voice_recording', created.id);
      return created;
    });
    return this.serialize(row, file, null, null);
  }

  /** Переименование: лёгкий ответ (веб патчит title в кэше списка, полный DTO не нужен) */
  async rename(userId: string, id: string, title: string): Promise<{ id: string; title: string }> {
    await this.assertOwner(userId, id);
    const row = await this.db.voiceRecording.update({ where: { id }, data: { title } });
    // title только что задан руками — он непустой по определению схемы входа
    return { id: row.id, title: row.title ?? title };
  }

  // ============================================================
  // Корзина (мягкое скрытие 30 дней, по образцу Заметок и Диска)
  // ============================================================

  /** В корзину: запись пропадает из ленты, файл и транскрипт живы до окончательного удаления. */
  async trash(userId: string, id: string): Promise<void> {
    const row = await this.assertOwner(userId, id, { includeTrashed: true });
    if (row.deletedAt) return;
    await this.db.voiceRecording.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
  }

  async restore(userId: string, id: string): Promise<VoiceRecordingDto> {
    const row = await this.assertOwner(userId, id, { includeTrashed: true });
    if (row.deletedAt) await this.db.voiceRecording.updateMany({ where: { id, deletedAt: row.deletedAt }, data: { deletedAt: null } });
    const fresh = await this.db.voiceRecording.findUniqueOrThrow({ where: { id } });
    return (await this.serializeMany([fresh]))[0];
  }

  /** Корзина владельца: записи с файлом (послушать перед восстановлением), новые сверху. */
  async listTrash(userId: string): Promise<VoiceRecordingTrashItem[]> {
    const rows = await this.db.voiceRecording.findMany({
      where: { ownerId: userId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      take: RECORDER_LIMITS.trashPageSize,
    });
    const dtos = await this.serializeMany(rows);
    return dtos.map((d, i) => ({
      ...d,
      deletedAt: rows[i].deletedAt!.toISOString(),
      purgeAt: new Date(rows[i].deletedAt!.getTime() + RECORDER_LIMITS.trashRetentionDays * 86_400_000).toISOString(),
    }));
  }

  /** Удалить навсегда — только из корзины. */
  async purge(userId: string, id: string): Promise<void> {
    const row = await this.assertOwner(userId, id, { includeTrashed: true });
    if (!row.deletedAt) throw badRequest('recorder.trashFirst');
    await this.hardDelete(id);
  }

  /** Корзина старше срока — навсегда (крон под Redis-локом; раннер purge core/lifecycle). */
  /**
   * Пачка корзины (шаг `recorder.trash` раннера сроков core/lifecycle): записи, удалённые
   * раньше `before`, keyset (deletedAt, id); удерживаемые заморозкой пропускаются.
   */
  async purgeTrashBatch(opts: { before: Date; limit: number; cursor: string | null; releasable: (tx: Prisma.TransactionClient, ids: readonly string[]) => Promise<string[]>; }): Promise<{ rows: number; more: boolean; cursor: string | null }> {
    const take = Math.min(opts.limit, RECORDER_LIMITS.purgeBatch);
    const c = decodeCursor(opts.cursor, REC_TRASH_CURSOR);
    const rows = await this.db.voiceRecording.findMany({
      where: { deletedAt: { lt: opts.before }, ...(c ? { OR: [{ deletedAt: { gt: c.d } }, { deletedAt: c.d, id: { gt: c.i } }] } : {}) },
      select: { id: true, deletedAt: true },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      take,
    });
    if (!rows.length) return { rows: 0, more: false, cursor: null };
    const ok = await this.db.$transaction((tx) => opts.releasable(tx, rows.map((r) => r.id)));
    for (const id of ok) await this.hardDelete(id);
    const last = rows[rows.length - 1]!;
    return { rows: ok.length, more: rows.length === take, cursor: encodeCursor({ d: last.deletedAt, i: last.id }) };
  }

  countTrashDue(before: Date): Promise<number> {
    return this.db.voiceRecording.count({ where: { deletedAt: { lt: before } } });
  }

  /** Окончательное удаление: отвязка (движок реапит осиротевший файл) → транскрипты ТОЛЬКО прибранных файлов → строка */
  private async hardDelete(id: string): Promise<void> {
    const fileIds = await this.files.getLinkedFileIds('voice_recording', id);
    await this.files.unlinkAllForRef('voice_recording', id);
    // Транскрипт умирает только вместе с файлом: файл, живущий вложением чата,
    // сохраняет общий транскрипт («1 файл = 1 транскрипт навсегда»)
    await this.voice.deleteForReapedFiles(fileIds);
    await this.db.voiceRecording.delete({ where: { id } });
  }

  private async assertOwner(userId: string, id: string, opts: { includeTrashed?: boolean } = {}): Promise<VoiceRecording> {
    const row = await this.db.voiceRecording.findUnique({ where: opts.includeTrashed ? { id } : { id, deletedAt: null } });
    if (!row) throw notFound('recorder.notFound');
    if (row.ownerId !== userId) throw forbidden('recorder.notOwner');
    return row;
  }

  /**
   * Название записи для ЛЕНТЫ — в языке запроса. Пустой `title` в БД означает
   * «имени нет»: оно собирается здесь, при чтении (render-at-read), потому что
   * записанное автоимя навсегда осталось бы в языке, который был у человека в
   * момент создания. Дата и время — общими форматтерами: свой `DD.MM.YYYY` был
   * бы сразу и языком, и регионом, зашитыми в строку.
   */
  private displayTitle(row: AutoTitleRow, locale?: Locale, timeZone?: string): string {
    if (row.title) return row.title;
    const at = row.titleAt ?? row.createdAt;
    const f = this.i18n.format(locale, timeZone);
    const key = row.source === 'call' ? 'recorder.callTitle' : 'recorder.defaultTitle';
    return locale
      ? this.i18n.translateFor(locale, key, { date: f.date(at), time: f.time(at) })
      : this.i18n.translate(key, { date: f.date(at), time: f.time(at) });
  }

  /**
   * То же для ФОНА (уведомление): языка запроса у джоба нет, поэтому берём язык и
   * пояс АДРЕСАТА. Снимок имени в уведомлении застывает — это осознанно: лента
   * уведомлений живёт неделями, а карточка записи перерисуется при следующем чтении.
   */
  async titleFor(userId: string, row: AutoTitleRow): Promise<string> {
    if (row.title) return row.title;
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { locale: true, timezone: true },
    });
    return this.displayTitle(row, coerceLocale(user?.locale), user?.timezone ?? undefined);
  }

  private serialize(
    row: VoiceRecording,
    file: FileDto | null,
    transcriptStatus: VoiceTranscriptStatus | null,
    transcriptDurationMs: number | null,
  ): VoiceRecordingDto {
    const fileMeta = (file?.meta as Record<string, unknown> | null) ?? {};
    const metaDuration = typeof fileMeta.durationMs === 'number' ? fileMeta.durationMs : null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      title: this.displayTitle(row),
      source: row.source as VoiceRecordingSource,
      language: (row.language as VoiceLanguage | null) ?? null,
      // Длительность живёт у файла (конвейер) с добором из транскрипта (STT посчитал);
      // своей колонки-снимка у записи нет — один источник правды
      durationMs: metaDuration ?? transcriptDurationMs,
      createdAt: row.createdAt.toISOString(),
      file,
      transcriptStatus,
    };
  }
}
