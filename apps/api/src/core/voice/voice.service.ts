import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, VoiceTranscript } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import {
  RequestTranscriptInput,
  VOICE_LIMITS,
  VoiceLanguage,
  VoiceSegment,
  VoiceStatusDto,
  VoiceSyncSttResult,
  VoiceTranscriptDto,
  VoiceTranscriptStatus,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FilesService } from '../files/files.service';
import { JobContext, JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { VoiceSttClient } from './voice-stt.client';
import { VoiceAudioPrep } from './voice-audio';

/** Тип джоба STT-транскрипции в реестре core/jobs. */
const VOICE_TRANSCRIBE_JOB = 'voice.transcribe';

/**
 * Постоянный отказ STT-провайдера. Клиент бросает Error с текстом `STT <код>: …`;
 * 4xx — претензия к НАШЕМУ запросу (формат, ключ, размер), от повтора он валиднее не
 * станет. Исключения — 408 и 429 (перегрузка) и все 5xx: это транзиент, их ретраим.
 */
function isPermanentSttFailure(message: string): boolean {
  const m = /^STT (\d{3}):/.exec(message);
  if (!m) return false;
  const status = Number(m[1]);
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Голосовой движок (core/voice, 7-й платформенный): транскрипция аудио-файлов
 * движка файлов. Транскрипт ключуется по fileId — 1 файл = 1 расчёт навсегда
 * (Telegram-модель «Расшифровать»). Исполнение — джоб core/jobs `voice.transcribe`
 * (очередь 'voice', cap 2, аренда = бюджет STT): строка VoiceTranscript остаётся
 * результатом/API/дедупом, доменный клейм queued|processing→processing + клейм-токен
 * attempts гардят финальную запись от лизинг-кражи. Доступ к транскрипту = доступ к
 * файлу (FilesService.getMeta → резолвер привязанной сущности из FilesRefRegistry).
 */
@Injectable()
export class VoiceService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly files: FilesService,
    private readonly stt: VoiceSttClient,
    private readonly audio: VoiceAudioPrep,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
  ) {}

  onModuleInit(): void {
    // Регистрируем обработчик только при доступном STT — иначе джобы не ставятся и
    // 'voice'-очередь без поллера (паттерн scanHook). maxAttempts = ретраи домена.
    if (!this.stt.enabled) return;
    this.jobsRegistry.register(
      VOICE_TRANSCRIBE_JOB,
      (payload, ctx) => this.handleTranscribeJob(String(payload.fileId), ctx),
      {
        queue: 'voice',
        queueConcurrency: 2,
        maxAttempts: VOICE_LIMITS.transcriptMaxAttempts,
        // Аренда — из общей константы, чтобы её нельзя было разъехать с суммой
        // внутренних таймаутов обработчика (см. комментарий к jobLeaseMs).
        leaseMs: VOICE_LIMITS.jobLeaseMs,
        onDiscard: (payload, info) =>
          this.markTranscriptDiscarded(String(payload.fileId), info.error),
      },
    );
  }

  onApplicationBootstrap(): void {
    if (!this.stt.enabled) return;
    void this.backfillTranscribeJobs().catch((err) =>
      this.logger.warn(`voice backfill failed: ${String((err as Error)?.message ?? err)}`),
    );
  }

  /**
   * Джоб транскрипции окончательно похоронен. Критично для случая, когда джоб умер ПО
   * АРЕНДЕ (краш/зависание инстанса) — тогда catch обработчика не отрабатывал и строка
   * осталась бы в 'processing' навсегда: веб бесконечно крутит «Расшифровываю…».
   */
  private async markTranscriptDiscarded(fileId: string, error: string): Promise<void> {
    const row = await this.db.voiceTranscript.findUnique({
      where: { fileId },
      select: { requestedById: true, status: true },
    });
    if (!row || row.status === 'ready' || row.status === 'error') return;
    await this.finishError(fileId, error, row.requestedById, {
      fromStatus: row.status as 'processing' | 'queued',
    });
  }

  /** Поставить джоб транскрипции (в tx запроса/сброса; uniqueKey `vt:<fileId>` дедупит). */
  private async enqueueTranscribe(tx: Prisma.TransactionClient | null, fileId: string): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: VOICE_TRANSCRIBE_JOB,
      payload: { fileId },
      uniqueKey: `vt:${fileId}`,
    });
  }

  /**
   * Бэкфилл при старте (onApplicationBootstrap): строки queued|processing без живого
   * джоба (потерянный enqueue до перезапуска) → ставим джоб. uniqueKey + проверка
   * существующих джобов дедупят; наличие любого джоба (в т.ч. discarded) → пропуск.
   */
  private async backfillTranscribeJobs(): Promise<void> {
    const rows = await this.db.voiceTranscript.findMany({
      where: { status: { in: ['queued', 'processing'] } },
      orderBy: { updatedAt: 'asc' },
      take: 500,
      select: { fileId: true },
    });
    if (rows.length === 0) return;
    const keys = rows.map((r) => `vt:${r.fileId}`);
    // Только ЖИВЫЕ джобы: терминальный джоб не должен навсегда занимать ключ, иначе
    // осиротевшая строка не поднялась бы никогда. От бесконечных повторов защищает
    // терминальный status='error' (его ставит markTranscriptDiscarded).
    const existing = await this.db.job.findMany({
      where: {
        type: VOICE_TRANSCRIBE_JOB,
        uniqueKey: { in: keys },
        status: { in: ['available', 'executing'] },
      },
      select: { uniqueKey: true },
    });
    const have = new Set(existing.map((j) => j.uniqueKey));
    let enqueued = 0;
    for (const r of rows) {
      if (have.has(`vt:${r.fileId}`)) continue;
      await this.enqueueTranscribe(null, r.fileId);
      enqueued++;
    }
    if (enqueued > 0) this.logger.log(`voice backfill: enqueued ${enqueued} job(s)`);
  }

  getStatus(): VoiceStatusDto {
    return {
      enabled: this.stt.enabled,
      mock: this.stt.mockMode,
    };
  }

  /**
   * Запросить расшифровку (идемпотентно): существующий транскрипт возвращается
   * как есть; error → сброс в queued (attempts=0); language влияет только на
   * первый расчёт или ре-запрос после ошибки — результат кэшируется навсегда.
   */
  async requestTranscript(userId: string, input: RequestTranscriptInput): Promise<VoiceTranscriptDto> {
    if (!this.stt.enabled) {
      throw new BadRequestException('Расшифровка не подключена (VOICE_STT_URL не задан)');
    }
    const file = await this.files.getMeta(userId, input.fileId); // 403/404 по правам
    if (file.kind !== 'audio') throw new BadRequestException('Расшифровка доступна только для аудио');
    if (file.status !== 'ready') throw new BadRequestException('Файл ещё не загружен');
    if (file.scanStatus === 'infected') {
      // Обречённый джоб не ставим: движок файлов всё равно не отдаст байты заражённого
      throw new BadRequestException('Файл помечен как заражённый — расшифровка недоступна');
    }

    const language = (input.language as VoiceLanguage | undefined) ?? 'auto';
    let row = await this.db.voiceTranscript.findUnique({ where: { fileId: input.fileId } });

    if (!row) {
      try {
        // Создание строки + постановка джоба — в одной транзакции (transactional outbox):
        // коммит = джоб есть, откат = нет ни строки, ни джоба.
        row = await this.db.$transaction(async (tx) => {
          const created = await tx.voiceTranscript.create({
            data: {
              fileId: input.fileId,
              status: 'queued',
              language,
              diarize: input.diarize ?? false,
              requestedById: userId,
            },
          });
          await this.enqueueTranscribe(tx, input.fileId);
          return created;
        });
      } catch (err) {
        // Конкурентный первый запрос: unique(fileId) → берём чужую строку (её джоб уже стоит)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          row = await this.db.voiceTranscript.findUniqueOrThrow({ where: { fileId: input.fileId } });
        } else {
          throw err;
        }
      }
    } else if (row.status === 'error') {
      // Явный ре-запрос после терминальной ошибки — новый цикл попыток + новый джоб.
      // Старый джоб терминален (discarded/completed) → uniqueKey свободен для нового.
      const prevDiarize = row.diarize;
      await this.db.$transaction(async (tx) => {
        const reset = await tx.voiceTranscript.updateMany({
          where: { fileId: input.fileId, status: 'error' },
          data: {
            // attempts НЕ обнуляем: это монотонный клейм-токен строки на всю её жизнь —
            // сброс позволил бы зомби-заходу прошлого цикла совпасть токеном с новым.
            status: 'queued',
            error: null,
            language,
            diarize: input.diarize ?? prevDiarize,
            requestedById: userId,
          },
        });
        if (reset.count === 1) await this.enqueueTranscribe(tx, input.fileId);
      });
      row = await this.db.voiceTranscript.findUniqueOrThrow({ where: { fileId: input.fileId } });
    } else if (row.status === 'queued') {
      // Пред-существующая queued (потерянный джоб до перезапуска) — подстрахуемся;
      // uniqueKey дедупит, если живой джоб уже есть.
      await this.enqueueTranscribe(null, input.fileId);
    }

    return this.serialize(row);
  }

  async getTranscript(viewerId: string, fileId: string): Promise<VoiceTranscriptDto> {
    await this.files.getMeta(viewerId, fileId); // 403/404 по правам файла
    const row = await this.db.voiceTranscript.findUnique({ where: { fileId } });
    if (!row) throw new NotFoundException('Расшифровка не запрашивалась');
    return this.serialize(row);
  }

  /**
   * Батч-статусы транскриптов для потребителей (список Диктофона, будущие протоколы):
   * таблица движка не наружу — потребители не пишут запросы в voice_transcripts сами.
   */
  async getStatusesForFiles(
    fileIds: string[],
  ): Promise<Map<string, { status: VoiceTranscriptStatus; durationMs: number | null }>> {
    if (!fileIds.length) return new Map();
    const rows = await this.db.voiceTranscript.findMany({
      where: { fileId: { in: [...new Set(fileIds)] } },
      select: { fileId: true, status: true, durationMs: true },
    });
    return new Map(rows.map((r) => [r.fileId, { status: r.status as VoiceTranscriptStatus, durationMs: r.durationMs }]));
  }

  /**
   * Удалить транскрипты УЖЕ ПРИБРАННЫХ файлов (после реапа сущностью-потребителем).
   * Файл, живущий другой привязкой (голосовое в чате ← запись Диктофона), остаётся
   * ready — его транскрипт общий и НЕ трогается: «1 файл = 1 транскрипт навсегда».
   */
  async deleteForReapedFiles(fileIds: string[]): Promise<void> {
    if (!fileIds.length) return;
    await this.db.voiceTranscript.deleteMany({
      where: { fileId: { in: [...new Set(fileIds)] }, file: { status: 'deleted' } },
    });
  }

  /**
   * Синхронная расшифровка короткого аудио (фундамент голосовых AI-команд и
   * SuperTerminal6): без строки в БД — prep → драйвер → текст.
   */
  async transcribeSync(
    tmpPath: string,
    mime: string,
    originalName: string,
    language?: VoiceLanguage,
  ): Promise<VoiceSyncSttResult> {
    if (!this.stt.enabled) {
      throw new BadRequestException('Расшифровка не подключена (VOICE_STT_URL не задан)');
    }
    const prep = await this.audio.prepareForStt(tmpPath, mime, originalName);
    try {
      const stat = await fs.promises.stat(prep.path);
      const result = await this.stt.transcribe({
        filePath: prep.path,
        mime: prep.mime,
        fileName: prep.fileName,
        language: language && language !== 'auto' ? language : undefined,
        timeoutMs: this.timeoutFor(prep.durationMs, stat.size),
      });
      return { text: result.text, language: result.language };
    } finally {
      await prep.cleanup();
    }
  }

  /**
   * Обработчик джоба `voice.transcribe`: доменный клейм queued|processing→processing
   * (второй ремень против лизинг-кражи; processing = наш прежний заход — продолжаем,
   * модель ScheduledMessage) + attempts=ctx.attempt (клейм-токен финальной записи).
   * Транзиентная ошибка → throw (движок ретраит с бэкоффом); недоступный/заражённый
   * файл → error + JobDiscardError; на последней попытке STT-ошибка тоже пишет error.
   */
  private async handleTranscribeJob(fileId: string, ctx: JobContext): Promise<void> {
    // Доменный клейм: queued|processing → processing. 'processing' = наш прежний заход
    // (ретрай/переклейм), продолжаем — модель ScheduledMessage {in:[...]}. attempts —
    // клейм-токен: reaper-переклейм джоба даст ctx.attempt+1, старый заход не затрёт строку.
    const claimed = await this.db.voiceTranscript.updateMany({
      where: { fileId, status: { in: ['queued', 'processing'] } },
      data: { status: 'processing', attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return; // ready/error/absent → нечего делать (идемпотентно)

    const row = await this.db.voiceTranscript.findUniqueOrThrow({
      where: { fileId },
      include: { file: true },
    });
    // Клейм-токен — МОНОТОННЫЙ счётчик строки, а не ctx.attempt: у нового джоба того же
    // файла ctx.attempt снова начинается с 1, и зомби-заход прошлого джоба совпал бы
    // токеном и затёр свежий результат (плюс лишний voice.transcript.ready).
    const attempt = row.attempts;
    const file = row.file;
    if (file.status !== 'ready' || file.scanStatus === 'infected') {
      await this.finishError(
        fileId,
        file.scanStatus === 'infected' ? 'Файл помечен как заражённый' : 'Файл недоступен',
        row.requestedById,
        { attempt },
      );
      // Постоянная причина — ретраи бессмысленны, хороним джоб сразу.
      throw new JobDiscardError(`voice ${fileId}: файл недоступен/заражён`);
    }

    const meta = (file.meta as Record<string, unknown> | null) ?? {};
    const knownDurationMs = typeof meta.durationMs === 'number' ? meta.durationMs : null;
    const sttTimeoutMs = this.timeoutFor(knownDurationMs, Number(file.size));

    let tmpSource: string | null = null;
    let prep: Awaited<ReturnType<VoiceAudioPrep['prepareForStt']>> | null = null;
    try {
      // Байты: на local-драйвере читаем прямо с диска (без стрим-копии 200 МБ), s3 → tmp
      let sourcePath = this.files.localPathFor(file.storageKey);
      if (!sourcePath) {
        tmpSource = path.join(os.tmpdir(), `sa6-voice-src-${randomUUID()}`);
        const { result } = await this.files.openRawStream(fileId, null);
        await pipeline(result.stream, fs.createWriteStream(tmpSource));
        sourcePath = tmpSource;
      }

      prep = await this.audio.prepareForStt(sourcePath, file.mime, file.name, knownDurationMs);
      const durationMs = knownDurationMs ?? prep.durationMs;

      const language = row.language && row.language !== 'auto' ? (row.language as VoiceLanguage) : undefined;
      const stt = await this.stt.transcribe({
        filePath: prep.path,
        mime: prep.mime,
        fileName: prep.fileName,
        language: language as Exclude<VoiceLanguage, 'auto'> | undefined,
        timeoutMs: sttTimeoutMs,
      });

      const finalDurationMs =
        durationMs ?? (stt.durationSec != null ? Math.round(stt.durationSec * 1000) : null);
      const done = await this.db.voiceTranscript.updateMany({
        where: { fileId, status: 'processing', attempts: attempt },
        data: {
          status: 'ready',
          text: stt.text,
          segments: stt.segments as unknown as Prisma.InputJsonValue,
          detectedLanguage: stt.language,
          durationMs: finalDurationMs,
          provider: stt.provider,
          model: stt.model,
          error: null,
          readyAt: new Date(),
        },
      });
      if (done.count === 1) {
        this.events.emit(
          'voice.transcript.ready',
          {
            fileId,
            requestedById: row.requestedById,
            durationMs: finalDurationMs,
            // Привязки файла в payload: потребители фильтруют свои события по refType
            // без запроса в fileLink на каждый чужой транскрипт
            links: await this.files.listLinksOfFile(fileId),
          },
          'voice',
        );
      }
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.logger.warn(`transcript ${fileId} (попытка ${ctx.attempt}/${ctx.maxAttempts}): ${message}`);
      // ПОСТОЯННЫЙ отказ STT ретраить бессмысленно: 400 «unsupported format», 401
      // «неверный ключ», 413 «слишком большой файл» повторятся слово в слово, а в конце
      // движок напишет error-лог и job.discarded — ложный инцидент вместо честного
      // «расшифровать нельзя». Транзиентными оставляем 408/429 (перегрузка) и все 5xx.
      if (isPermanentSttFailure(message)) {
        await this.finishError(fileId, message, row.requestedById, { attempt });
        throw new JobDiscardError(`transcript ${fileId}: STT отказал постоянно — ${message}`);
      }
      // На последней попытке пишем терминальный error (API/поллинг увидит финал), затем
      // бросаем — движок кладёт джоб в dead-letter. Иначе просто бросаем → бэкофф-ретрай
      // (строка остаётся 'processing', следующий заход её переклеймит).
      // Решение о «последней» — по попытке ДЖОБА; attempt выше — токен строки, не счётчик джоба.
      if (ctx.attempt >= ctx.maxAttempts) {
        await this.finishError(fileId, message, row.requestedById, { attempt });
      }
      throw err;
    } finally {
      if (tmpSource) await fs.promises.unlink(tmpSource).catch(() => undefined);
      if (prep) await prep.cleanup();
    }
  }

  // ---------- helpers ----------

  /** Таймаут STT: CPU-whisper медленнее реального времени; без длительности — от размера (~1 мин/МБ) */
  private timeoutFor(durationMs: number | null, sizeBytes: number): number {
    const byDuration = durationMs != null ? VOICE_LIMITS.sttTimeoutPerAudioFactor * durationMs : null;
    const bySize = Math.ceil(sizeBytes / (1024 * 1024)) * 60_000;
    const extra = byDuration ?? bySize;
    return Math.min(VOICE_LIMITS.sttTimeoutMaxMs, VOICE_LIMITS.sttTimeoutBaseMs + extra);
  }

  private async finishError(
    fileId: string,
    message: string,
    requestedById: string,
    opts?: { attempt?: number; fromStatus?: 'processing' | 'queued' },
  ): Promise<void> {
    const done = await this.db.voiceTranscript.updateMany({
      where: {
        fileId,
        status: opts?.fromStatus ?? 'processing',
        ...(opts?.attempt != null ? { attempts: opts.attempt } : {}),
      },
      data: { status: 'error', error: message.slice(0, 500) },
    });
    if (done.count === 1) {
      this.events.emit(
        'voice.transcript.failed',
        {
          fileId,
          requestedById,
          error: message.slice(0, 200),
          links: await this.files.listLinksOfFile(fileId),
        },
        'voice',
      );
    }
  }

  private serialize(row: VoiceTranscript): VoiceTranscriptDto {
    return {
      fileId: row.fileId,
      status: row.status as VoiceTranscriptDto['status'],
      language: (row.language as VoiceLanguage | null) ?? null,
      detectedLanguage: row.detectedLanguage,
      text: row.text,
      segments: (row.segments as unknown as VoiceSegment[] | null) ?? null,
      durationMs: row.durationMs,
      diarize: row.diarize,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    };
  }
}
