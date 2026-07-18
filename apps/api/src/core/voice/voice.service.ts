import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FilesService } from '../files/files.service';
import { VoiceSttClient } from './voice-stt.client';
import { VoiceAudioPrep } from './voice-audio';

/**
 * Голосовой движок (core/voice, 7-й платформенный): транскрипция аудио-файлов
 * движка файлов. Транскрипт ключуется по fileId — 1 файл = 1 расчёт навсегда
 * (Telegram-модель «Расшифровать»). Джоб = строка VoiceTranscript: клейм
 * status-guarded updateMany + аренда leaseUntil (крон переклеймивает только
 * протухшую аренду — живой джоб не задваивается) + Redis-лок; финальные записи
 * гардятся клейм-токеном attempts. Доступ к транскрипту = доступ к файлу
 * (FilesService.getMeta → резолвер привязанной сущности из FilesRefRegistry).
 */
@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly events: EventBusService,
    private readonly files: FilesService,
    private readonly stt: VoiceSttClient,
    private readonly audio: VoiceAudioPrep,
  ) {}

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
        row = await this.db.voiceTranscript.create({
          data: {
            fileId: input.fileId,
            status: 'queued',
            language,
            diarize: input.diarize ?? false,
            requestedById: userId,
          },
        });
      } catch (err) {
        // Конкурентный первый запрос: unique(fileId) → берём чужую строку
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          row = await this.db.voiceTranscript.findUniqueOrThrow({ where: { fileId: input.fileId } });
        } else {
          throw err;
        }
      }
    } else if (row.status === 'error') {
      // Явный ре-запрос после терминальной ошибки — новый цикл попыток
      const reset = await this.db.voiceTranscript.updateMany({
        where: { fileId: input.fileId, status: 'error' },
        data: {
          status: 'queued',
          attempts: 0,
          error: null,
          leaseUntil: null,
          language,
          diarize: input.diarize ?? row.diarize,
          requestedById: userId,
        },
      });
      if (reset.count === 1) {
        row = await this.db.voiceTranscript.findUniqueOrThrow({ where: { fileId: input.fileId } });
      }
    }

    if (row.status === 'queued') this.kick(input.fileId);
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

  /** Fire-and-forget запуск джоба (из requestTranscript и крона) */
  kick(fileId: string): void {
    this.execute(fileId).catch((err) =>
      this.logger.warn(`transcript ${fileId}: ${err instanceof Error ? err.message : err}`),
    );
  }

  /**
   * Исполнить джоб: Redis-лок + клейм queued→processing (count!==1 → занято/уже готово)
   * + аренда leaseUntil по бюджету ЭТОГО джоба (overhead + STT-таймаут + запас) — крон
   * переклеймивает только протухшую аренду. Все финальные записи гардятся клейм-токеном
   * attempts: поздняя запись отставшего джоба не заденет переклеймленную строку.
   * Ошибки: транзиентные возвращают в queued до лимита попыток, дальше терминальный error.
   */
  async execute(fileId: string): Promise<void> {
    await this.redis.withLock(`voice:stt:${fileId}`, VOICE_LIMITS.sttLockTtlMs, async () => {
      const claimed = await this.db.voiceTranscript.updateMany({
        where: { fileId, status: 'queued' },
        data: { status: 'processing', attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) return;

      const row = await this.db.voiceTranscript.findUniqueOrThrow({
        where: { fileId },
        include: { file: true },
      });
      const attempt = row.attempts; // клейм-токен финальных записей
      const file = row.file;
      if (file.status !== 'ready' || file.scanStatus === 'infected') {
        await this.finishError(
          fileId,
          file.scanStatus === 'infected' ? 'Файл помечен как заражённый' : 'Файл недоступен',
          row.requestedById,
          { attempt },
        );
        return;
      }

      const meta = (file.meta as Record<string, unknown> | null) ?? {};
      const knownDurationMs = typeof meta.durationMs === 'number' ? meta.durationMs : null;
      const sttTimeoutMs = this.timeoutFor(knownDurationMs, Number(file.size));
      // Аренда: живой джоб не переживёт свой бюджет (у скачивания/prep/STT свои таймауты)
      await this.db.voiceTranscript.update({
        where: { fileId },
        data: {
          leaseUntil: new Date(Date.now() + VOICE_LIMITS.sttJobOverheadMs + sttTimeoutMs + VOICE_LIMITS.sttLeaseMarginMs),
        },
      });

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
            leaseUntil: null,
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
        const terminal = attempt >= VOICE_LIMITS.transcriptMaxAttempts;
        this.logger.warn(`transcript ${fileId} (попытка ${attempt}${terminal ? ', terminal' : ''}): ${message}`);
        if (terminal) {
          await this.finishError(fileId, message, row.requestedById, { attempt });
        } else {
          // Транзиентно: назад в очередь, добьёт крон
          await this.db.voiceTranscript.updateMany({
            where: { fileId, status: 'processing', attempts: attempt },
            data: { status: 'queued', error: message, leaseUntil: null },
          });
        }
      } finally {
        if (tmpSource) await fs.promises.unlink(tmpSource).catch(() => undefined);
        if (prep) await prep.cleanup();
      }
    });
  }

  /** Крон-редрайв: потерянные queued и processing с протухшей арендой (упавший инстанс) */
  async redriveStuck(): Promise<number> {
    let kicked = 0;

    const staleQueued = await this.db.voiceTranscript.findMany({
      where: { status: 'queued', updatedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) } },
      orderBy: { updatedAt: 'asc' },
      take: 10,
      select: { fileId: true },
    });
    for (const t of staleQueued) {
      this.kick(t.fileId);
      kicked++;
    }

    // Аренда протухла = инстанс умер посреди джоба (живой джоб всегда короче своей
    // аренды); строки без аренды (клейм упал до её записи) — по worst-case бюджету
    const worstBudgetMs =
      VOICE_LIMITS.sttJobOverheadMs + VOICE_LIMITS.sttTimeoutMaxMs + VOICE_LIMITS.sttLeaseMarginMs;
    const staleProcessing = await this.db.voiceTranscript.findMany({
      where: {
        status: 'processing',
        OR: [
          { leaseUntil: { lt: new Date() } },
          { leaseUntil: null, updatedAt: { lt: new Date(Date.now() - worstBudgetMs) } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 10,
    });
    for (const t of staleProcessing) {
      if (t.attempts >= VOICE_LIMITS.transcriptMaxAttempts) {
        await this.finishError(t.fileId, t.error ?? 'Инстанс прервался, попытки исчерпаны', t.requestedById, {
          attempt: t.attempts,
        });
        continue;
      }
      const reset = await this.db.voiceTranscript.updateMany({
        where: { fileId: t.fileId, status: 'processing', attempts: t.attempts },
        data: { status: 'queued', leaseUntil: null },
      });
      if (reset.count === 1) {
        this.kick(t.fileId);
        kicked++;
      }
    }
    return kicked;
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
      data: { status: 'error', error: message.slice(0, 500), leaseUntil: null },
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
