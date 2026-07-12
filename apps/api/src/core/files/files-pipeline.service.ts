import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { FILE_LIMITS, FILE_PROFILES, VOICE_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage-driver';

/**
 * Узкая типизация sharp (v0.35 — dual-package, его ESM-типы не дружат с module:commonjs
 * без esModuleInterop; CJS-рантайм — module.exports = Sharp, поэтому require надёжен).
 */
interface SharpInstance {
  rotate(): SharpInstance;
  resize(opts: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpInstance;
  webp(opts: { quality: number }): SharpInstance;
  toFile(path: string): Promise<{ width: number; height: number; size: number }>;
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp') as (input?: string) => SharpInstance;

/**
 * Медиа-конвейер движка файлов: варианты изображений (sharp: EXIF/GPS срезается по
 * умолчанию, rotate() до среза — портреты не лягут набок), постер-кадр видео (ffmpeg,
 * decode-only) и длительность аудио/видео (ffprobe). Асинхронный: файл уже ready,
 * ошибка варианта НЕ ошибка файла (meta.pipeline=failed, крон ретраит ≤3 раз).
 * Клейм — Redis-лок на файл (двойной запуск complete+крон не задвоит работу).
 */
@Injectable()
export class FilesPipelineService {
  private readonly logger = new Logger(FilesPipelineService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly events: EventBusService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
  ) {}

  /** Запуск обработки файла (fire-and-forget из complete(); повторно — из крона) */
  async process(fileId: string): Promise<void> {
    const ran = await this.redis.withLock(`files:pipeline:${fileId}`, 5 * 60 * 1000, () =>
      this.run(fileId),
    );
    if (ran === null) this.logger.debug(`pipeline ${fileId}: занят другим инстансом`);
  }

  private async run(fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status !== 'ready') return;
    const meta = (row.meta as Record<string, unknown> | null) ?? {};
    if (meta.pipeline === 'done') return;
    const spec = FILE_PROFILES[row.profile] ?? FILE_PROFILES.generic;
    if (!spec.makeVariants || !['image', 'video', 'audio'].includes(row.kind)) {
      await this.setPipeline(fileId, meta, { pipeline: 'done' });
      return;
    }

    // Источник: прямой путь (local) или скачивание во временный файл (s3)
    let source = this.driver.localPath(row.storageKey);
    let tempSource: string | null = null;
    try {
      if (!source) {
        tempSource = path.join(os.tmpdir(), `sa6-files-${randomUUID()}`);
        await this.downloadToFile(row.storageKey, tempSource);
        source = tempSource;
      }

      const patch: Record<string, unknown> = {};
      if (row.kind === 'image') {
        Object.assign(patch, await this.processImage(row.id, row.storageKey, source));
      } else if (row.kind === 'video') {
        Object.assign(patch, await this.processVideo(row.id, row.storageKey, source));
      } else if (row.kind === 'audio') {
        Object.assign(patch, await this.processAudio(row.profile, source));
      }

      await this.setPipeline(fileId, meta, { ...patch, pipeline: 'done', pipelineError: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retries = typeof meta.pipelineRetries === 'number' ? meta.pipelineRetries + 1 : 1;
      this.logger.warn(`pipeline ${fileId} failed (retry ${retries}): ${message}`);
      // Исчерпав попытки — терминальный 'exhausted', НЕ 'failed': иначе такие строки
      // навсегда занимают окно retryPending (take:20) и новые pending не доходят.
      await this.setPipeline(fileId, meta, {
        pipeline: retries >= FILE_LIMITS.pipelineMaxRetries ? 'exhausted' : 'failed',
        pipelineRetries: retries,
        pipelineError: message.slice(0, 500),
      });
    } finally {
      if (tempSource) await fs.promises.unlink(tempSource).catch(() => undefined);
    }
  }

  /** Ретрай зависших/упавших конвейеров (зовёт FilesCron). Возвращает число запусков. */
  async retryPending(): Promise<number> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const rows = await this.db.fileObject.findMany({
      where: {
        status: 'ready',
        readyAt: { lt: cutoff },
        OR: [
          { meta: { path: ['pipeline'], equals: 'pending' } },
          { meta: { path: ['pipeline'], equals: 'failed' } },
        ],
      },
      orderBy: { readyAt: 'asc' },
      take: 20,
    });
    let started = 0;
    for (const row of rows) {
      const meta = (row.meta as Record<string, unknown> | null) ?? {};
      const retries = typeof meta.pipelineRetries === 'number' ? meta.pipelineRetries : 0;
      if (retries >= FILE_LIMITS.pipelineMaxRetries) continue;
      await this.process(row.id);
      started++;
    }
    return started;
  }

  // ---------- image ----------

  private async processImage(
    fileId: string,
    storageKey: string,
    source: string,
  ): Promise<Record<string, unknown>> {
    const md = await sharp(source).metadata();
    let width = md.width ?? null;
    let height = md.height ?? null;
    // EXIF-ориентации 5–8 меняют стороны местами после rotate()
    if (md.orientation && md.orientation >= 5 && width && height) {
      [width, height] = [height, width];
    }

    const longest = Math.max(width ?? 0, height ?? 0);
    const wanted: Array<{ kind: string; size: number }> = [{ kind: 'thumb', size: FILE_LIMITS.thumbSize }];
    if (longest >= 640) wanted.push({ kind: 'medium', size: FILE_LIMITS.mediumSize });

    for (const v of wanted) {
      const out = path.join(os.tmpdir(), `sa6-var-${randomUUID()}.webp`);
      try {
        const info = await sharp(source)
          .rotate()
          .resize({ width: v.size, height: v.size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(out);
        await this.saveVariant(fileId, storageKey, v.kind, out, 'image/webp', {
          width: info.width,
          height: info.height,
        });
      } finally {
        await fs.promises.unlink(out).catch(() => undefined);
      }
    }
    return { width, height };
  }

  // ---------- video / audio ----------

  private async processVideo(
    fileId: string,
    storageKey: string,
    source: string,
  ): Promise<Record<string, unknown>> {
    const bins = this.ffBinaries();
    if (!bins) {
      this.logger.warn('ffmpeg/ffprobe недоступны — пропускаю обработку видео');
      return {};
    }
    const probe = await this.ffprobe(bins.ffprobe, source);
    const patch: Record<string, unknown> = {};
    if (probe.durationMs) patch.durationMs = probe.durationMs;
    if (probe.width) patch.width = probe.width;
    if (probe.height) patch.height = probe.height;

    const out = path.join(os.tmpdir(), `sa6-poster-${randomUUID()}.jpg`);
    try {
      // Постер-кадр: сначала с 1-й секунды, для сверхкоротких роликов — с нулевой
      try {
        await this.execFF(bins.ffmpeg, ['-y', '-ss', '1', '-i', source, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', out]);
      } catch {
        await this.execFF(bins.ffmpeg, ['-y', '-i', source, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', out]);
      }
      const stat = await fs.promises.stat(out);
      if (stat.size > 0) {
        await this.saveVariant(fileId, storageKey, 'poster', out, 'image/jpeg', {});
      }
    } finally {
      await fs.promises.unlink(out).catch(() => undefined);
    }
    return patch;
  }

  private async processAudio(profile: string, source: string): Promise<Record<string, unknown>> {
    const bins = this.ffBinaries();
    if (!bins) {
      this.logger.warn('ffprobe недоступен — пропускаю длительность аудио');
      return {};
    }
    const probe = await this.ffprobe(bins.ffprobe, source);
    const patch: Record<string, unknown> = {};
    if (probe.durationMs) patch.durationMs = probe.durationMs;

    // Волна (meta.waveform) — для голосовых всегда, для Диктофона до 10 мин;
    // best-effort: не получилась → файл живёт без волны (веб рисует обычный плеер)
    const withinCap = probe.durationMs == null || probe.durationMs <= VOICE_LIMITS.waveformMaxDurationMs;
    if (withinCap && (profile === 'voice_message' || profile === 'dictaphone')) {
      const waveform = await this.computeWaveform(bins.ffmpeg, source);
      if (waveform) patch.waveform = waveform;
    }
    return patch;
  }

  /**
   * Волна голосового: децимация в 2 кГц mono s16 PCM во ВРЕМЕННЫЙ ФАЙЛ (execFF
   * возвращает stdout строкой — бинарный поток через него нельзя), RMS по
   * waveformBuckets корзинам, пик-нормировка 0..100.
   */
  private async computeWaveform(ffmpegBin: string, source: string): Promise<number[] | null> {
    const out = path.join(os.tmpdir(), `sa6-wave-${randomUUID()}.pcm`);
    try {
      await this.execFF(ffmpegBin, ['-y', '-i', source, '-ac', '1', '-ar', '2000', '-f', 's16le', out]);
      const buf = await fs.promises.readFile(out);
      const samples = Math.floor(buf.length / 2);
      if (!samples) return null;
      const buckets = VOICE_LIMITS.waveformBuckets;
      const per = Math.max(1, Math.floor(samples / buckets));
      const peaks: number[] = [];
      for (let b = 0; b < buckets; b++) {
        const from = b * per;
        if (from >= samples) break;
        const to = Math.min(samples, from + per);
        let sum = 0;
        for (let i = from; i < to; i++) {
          const v = buf.readInt16LE(i * 2);
          sum += v * v;
        }
        peaks.push(Math.sqrt(sum / (to - from)));
      }
      const max = Math.max(...peaks, 1);
      return peaks.map((p) => Math.round((p / max) * 100));
    } catch (err) {
      this.logger.warn(`waveform: ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      await fs.promises.unlink(out).catch(() => undefined);
    }
  }

  /** ffmpeg-static/ffprobe-static: их отсутствие не валит движок (dev без бинарников) */
  private ffBinaries(): { ffmpeg: string; ffprobe: string } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg: string | null = require('ffmpeg-static');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffprobe: { path: string } = require('ffprobe-static');
      if (!ffmpeg || !ffprobe?.path) return null;
      return { ffmpeg, ffprobe: ffprobe.path };
    } catch {
      return null;
    }
  }

  private async ffprobe(
    bin: string,
    source: string,
  ): Promise<{ durationMs: number | null; width: number | null; height: number | null }> {
    const raw = await this.execFF(bin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      source,
    ]);
    try {
      const data = JSON.parse(raw) as {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
      };
      const durationSec = data.format?.duration ? parseFloat(data.format.duration) : NaN;
      const video = data.streams?.find((s) => s.codec_type === 'video');
      return {
        durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
        width: video?.width ?? null,
        height: video?.height ?? null,
      };
    } catch {
      return { durationMs: null, width: null, height: null };
    }
  }

  private execFF(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${path.basename(bin)}: ${err.message} ${String(stderr).slice(0, 200)}`));
        else resolve(String(stdout));
      });
    });
  }

  // ---------- helpers ----------

  private async saveVariant(
    fileId: string,
    originalKey: string,
    kind: string,
    tmpPath: string,
    mime: string,
    variantMeta: Record<string, unknown>,
  ): Promise<void> {
    const stat = await fs.promises.stat(tmpPath);
    const dir = path.posix.dirname(originalKey.split(path.sep).join('/'));
    const ext = mime === 'image/webp' ? 'webp' : 'jpg';
    const key = `${dir}/${fileId}_${kind}.${ext}`;
    // putFromFile забирает tmp (rename/удаление) — копируем во «второй tmp» нельзя дважды;
    // поэтому вызываем непосредственно, а finally-unlink вызывающего молча промахнётся.
    await this.driver.putFromFile(key, tmpPath, mime);
    await this.db.fileVariant.upsert({
      where: { fileId_kind: { fileId, kind } },
      create: { fileId, kind, storageKey: key, mime, size: BigInt(stat.size), meta: variantMeta as object },
      update: { storageKey: key, mime, size: BigInt(stat.size), meta: variantMeta as object },
    });
    this.events.emit('file.variant.created', { fileId, kind, mime, size: stat.size }, 'files');
  }

  private async setPipeline(
    fileId: string,
    currentMeta: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const next: Record<string, unknown> = { ...currentMeta, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    await this.db.fileObject.update({
      where: { id: fileId },
      data: { meta: next as object },
    }).catch(() => undefined);
  }

  private async downloadToFile(key: string, dest: string): Promise<void> {
    const { stream } = await this.driver.getStream(key);
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
  }
}
