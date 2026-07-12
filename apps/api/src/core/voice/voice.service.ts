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
 * status-guarded updateMany + Redis-лок (дисциплина FilesScanHook/конвейера),
 * зависшее добивает VoiceCron. Доступ к транскрипту = доступ к файлу
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
      diarization: this.stt.diarization,
      languages: this.stt.languages,
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
   * Исполнить джоб: Redis-лок (TTL > макс. таймаута — живой джоб не переклеймится)
   * + клейм queued→processing (count!==1 → занято/уже готово). Ошибки: транзиентные
   * возвращают в queued до лимита попыток, дальше терминальный error.
   */
  async execute(fileId: string): Promise<void> {
    await this.redis.withLock(`voice:stt:${fileId}`, VOICE_LIMITS.sttLockTtlMs, async () => {
      const claimed = await this.db.voiceTranscript.updateMany({
        where: { fileId, status: 'queued' },
        data: { status: 'processing', attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) return;

      const row = await this.db.voiceTranscript.findUniqueOrThrow({ where: { fileId } });
      const file = await this.db.fileObject.findUnique({ where: { id: fileId } });
      if (!file || file.status !== 'ready') {
        await this.finishError(fileId, 'Файл недоступен', true, row.requestedById);
        return;
      }

      const tmpSource = path.join(os.tmpdir(), `sa6-voice-src-${randomUUID()}`);
      let prep: Awaited<ReturnType<VoiceAudioPrep['prepareForStt']>> | null = null;
      try {
        // Байты: системное чтение через движок файлов (local path или s3 → стрим)
        const { result } = await this.files.openRawStream(fileId, null);
        await pipeline(result.stream, fs.createWriteStream(tmpSource));

        prep = await this.audio.prepareForStt(tmpSource, file.mime, file.name);
        const meta = (file.meta as Record<string, unknown> | null) ?? {};
        const durationMs =
          prep.durationMs ?? (typeof meta.durationMs === 'number' ? meta.durationMs : null);

        const language = row.language && row.language !== 'auto' ? (row.language as VoiceLanguage) : undefined;
        const stt = await this.stt.transcribe({
          filePath: prep.path,
          mime: prep.mime,
          fileName: prep.fileName,
          language: language as Exclude<VoiceLanguage, 'auto'> | undefined,
          timeoutMs: this.timeoutFor(durationMs, Number(file.size)),
        });

        const finalDurationMs =
          durationMs ?? (stt.durationSec != null ? Math.round(stt.durationSec * 1000) : null);
        const done = await this.db.voiceTranscript.updateMany({
          where: { fileId, status: 'processing' },
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
            { fileId, requestedById: row.requestedById, durationMs: finalDurationMs },
            'voice',
          );
        }
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        const terminal = row.attempts >= VOICE_LIMITS.transcriptMaxAttempts;
        this.logger.warn(`transcript ${fileId} (попытка ${row.attempts}${terminal ? ', terminal' : ''}): ${message}`);
        if (terminal) {
          await this.finishError(fileId, message, true, row.requestedById);
        } else {
          // Транзиентно: назад в очередь, добьёт крон
          await this.db.voiceTranscript.updateMany({
            where: { fileId, status: 'processing' },
            data: { status: 'queued', error: message },
          });
        }
      } finally {
        await fs.promises.unlink(tmpSource).catch(() => undefined);
        if (prep) await prep.cleanup();
      }
    });
  }

  /** Крон-редрайв: потерянные queued и протухшие processing (упавший инстанс) */
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

    // processing старше TTL лока = инстанс умер посреди джоба (живой держит лок)
    const staleProcessing = await this.db.voiceTranscript.findMany({
      where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - VOICE_LIMITS.sttLockTtlMs) } },
      orderBy: { updatedAt: 'asc' },
      take: 10,
    });
    for (const t of staleProcessing) {
      if (t.attempts >= VOICE_LIMITS.transcriptMaxAttempts) {
        await this.finishError(t.fileId, t.error ?? 'Инстанс прервался, попытки исчерпаны', true, t.requestedById, 'processing');
        continue;
      }
      const reset = await this.db.voiceTranscript.updateMany({
        where: { fileId: t.fileId, status: 'processing', updatedAt: t.updatedAt },
        data: { status: 'queued' },
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
    emit: boolean,
    requestedById: string,
    fromStatus: 'processing' | 'queued' = 'processing',
  ): Promise<void> {
    const done = await this.db.voiceTranscript.updateMany({
      where: { fileId, status: fromStatus },
      data: { status: 'error', error: message.slice(0, 500) },
    });
    if (done.count === 1 && emit) {
      this.events.emit('voice.transcript.failed', { fileId, requestedById, error: message.slice(0, 200) }, 'voice');
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
