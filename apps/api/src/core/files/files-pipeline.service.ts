import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { FILE_LIMITS, FILE_PROFILES, VOICE_LIMITS, FileProfileSpec } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { execFF, ffBinaries, ffprobeFormat } from '../../shared/ffmpeg/ffmpeg.util';
import { mediaSemaphore } from '../../shared/utils/semaphore';
import { JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
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

/** Тип джоба медиа-конвейера в реестре core/jobs. */
const FILES_PIPELINE_JOB = 'files.pipeline';

/**
 * Медиа-конвейер движка файлов: варианты изображений (sharp: EXIF/GPS срезается по
 * умолчанию, rotate() до среза — портреты не лягут набок), постер-кадр видео (ffmpeg,
 * decode-only) и длительность аудио/видео (ffprobe). Асинхронный: файл уже ready,
 * ошибка варианта НЕ ошибка файла — джоб core/jobs (очередь 'media', cap 3) ретраит
 * с бэкоффом; meta.pipeline='done' — терминальный ремень идемпотентности обработчика.
 */
@Injectable()
export class FilesPipelineService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(FilesPipelineService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
  ) {}

  /**
   * Медиа-конвейер — джоб core/jobs (очередь 'media', cap 3 замещает семафор для
   * самих джобов; ffmpeg-постер/варианты — leaseMs 10 мин, maxAttempts 4). Обёртка
   * mediaSemaphore внутри — общий пер-инстансный потолок тяжёлых ffmpeg/sharp
   * (делится с подготовкой аудио core/voice). Ретраи/бэкофф/dead-letter — у движка.
   */
  onModuleInit(): void {
    this.jobsRegistry.register(
      FILES_PIPELINE_JOB,
      (payload) => mediaSemaphore.run(() => this.run(String(payload.fileId))),
      {
        queue: 'media',
        queueConcurrency: 3,
        // Окно ретраев должно перекрывать реальный простой хранилища/ffmpeg: прежний крон
        // добивал конвейер десятками минут, а 4 попытки по 30с — это всего ~3.5 минуты.
        maxAttempts: 5,
        backoffBaseMs: 60_000,
        // Аренда с запасом: обработчик сперва ЖДЁТ mediaSemaphore (общий с core/voice и
        // с синхронным /voice/stt), и это ожидание тоже течёт внутри аренды.
        leaseMs: 15 * 60 * 1000,
        onDiscard: (payload) => this.markPipelineExhausted(String(payload.fileId)),
      },
    );
  }

  onApplicationBootstrap(): void {
    void this.backfillPipelineJobs().catch((err) =>
      this.logger.warn(`pipeline backfill failed: ${String((err as Error)?.message ?? err)}`),
    );
  }

  /**
   * Джоб конвейера окончательно похоронен (в т.ч. reaper'ом по аренде — тогда обработчик
   * вообще не отрабатывал). Пишем ТЕРМИНАЛЬНЫЙ meta.pipeline='exhausted': иначе строка
   * осталась бы 'pending' и бэкфилл поднимал бы безнадёжный файл на каждом старте.
   */
  private async markPipelineExhausted(fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId }, select: { meta: true } });
    if (!row) return;
    const meta = (row.meta as Record<string, unknown> | null) ?? {};
    if (meta.pipeline === 'done') return;
    await this.setPipeline(fileId, meta, { pipeline: 'exhausted' });
  }

  /**
   * Поставить джоб конвейера — В ТОЙ ЖЕ транзакции, что и переход файла в ready
   * (complete/ingest): коммит = джоб есть, откат = джоба нет (transactional outbox).
   * uniqueKey `fp:<id>` дедупит повторную постановку среди живых джобов.
   */
  async enqueue(tx: Prisma.TransactionClient | null, fileId: string): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: FILES_PIPELINE_JOB,
      payload: { fileId },
      uniqueKey: `fp:${fileId}`,
    });
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
        Object.assign(patch, await this.processAudio(spec, source));
      }

      await this.setPipeline(fileId, meta, { ...patch, pipeline: 'done', pipelineError: undefined });
      // Ошибку НЕ гасим: бросаем — движок джобов ретраит с бэкоффом, исчерпание →
      // dead-letter (meta.pipeline остаётся 'pending', backfill пропустит по discarded-джобу).
    } finally {
      if (tempSource) await fs.promises.unlink(tempSource).catch(() => undefined);
    }
  }

  /**
   * Бэкфилл доджобовых конвейеров при старте (onApplicationBootstrap): ready-файлы,
   * застрявшие в meta.pipeline pending|failed без джоба (потерянный kickoff до
   * перезапуска). uniqueKey дедупит; наличие ЛЮБОГО джоба (в т.ч. discarded — «уже
   * сдались») → пропуск, чтобы не переигрывать безнадёжный конвейер на каждом старте.
   */
  private async backfillPipelineJobs(): Promise<void> {
    const rows = await this.db.fileObject.findMany({
      where: {
        status: 'ready',
        OR: [
          { meta: { path: ['pipeline'], equals: 'pending' } },
          { meta: { path: ['pipeline'], equals: 'failed' } },
        ],
      },
      orderBy: { readyAt: 'asc' },
      take: 500,
      select: { id: true, meta: true },
    });
    // Доджобовые 'failed' с исчерпанными старыми ретраями не воскрешаем.
    const eligible = rows.filter((r) => {
      const meta = (r.meta as Record<string, unknown> | null) ?? {};
      const retries = typeof meta.pipelineRetries === 'number' ? meta.pipelineRetries : 0;
      return retries < FILE_LIMITS.pipelineMaxRetries;
    });
    if (eligible.length === 0) return;
    const keys = eligible.map((r) => `fp:${r.id}`);
    // ТОЛЬКО живые джобы: терминальные (discarded/completed) не должны «вечно занимать»
    // ключ — иначе застрявший файл никогда не был бы поднят. От повторов безнадёжных
    // файлов защищает терминальный meta.pipeline='exhausted' (см. markPipelineExhausted).
    // Бонус: с этим предикатом запрос попадает в partial-unique jobs_unique_key_live.
    const existing = await this.db.job.findMany({
      where: {
        type: FILES_PIPELINE_JOB,
        uniqueKey: { in: keys },
        status: { in: ['available', 'executing'] },
      },
      select: { uniqueKey: true },
    });
    const have = new Set(existing.map((j) => j.uniqueKey));
    let enqueued = 0;
    for (const r of eligible) {
      if (have.has(`fp:${r.id}`)) continue;
      await this.enqueue(null, r.id);
      enqueued++;
    }
    if (enqueued > 0) this.logger.log(`pipeline backfill: enqueued ${enqueued} job(s)`);
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
    const bins = ffBinaries();
    if (!bins) {
      this.logger.warn('ffmpeg/ffprobe недоступны — пропускаю обработку видео');
      return {};
    }
    const probe = await ffprobeFormat(bins.ffprobe, source);
    const patch: Record<string, unknown> = {};
    if (probe.durationMs) patch.durationMs = probe.durationMs;
    if (probe.width) patch.width = probe.width;
    if (probe.height) patch.height = probe.height;

    const out = path.join(os.tmpdir(), `sa6-poster-${randomUUID()}.jpg`);
    try {
      // Постер-кадр: сначала с 1-й секунды, для сверхкоротких роликов — с нулевой
      try {
        await execFF(bins.ffmpeg, ['-y', '-ss', '1', '-i', source, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', out]);
      } catch {
        await execFF(bins.ffmpeg, ['-y', '-i', source, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', out]);
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

  private async processAudio(spec: FileProfileSpec, source: string): Promise<Record<string, unknown>> {
    const bins = ffBinaries();
    if (!bins) {
      this.logger.warn('ffprobe недоступен — пропускаю длительность аудио');
      return {};
    }
    const probe = await ffprobeFormat(bins.ffprobe, source);
    const patch: Record<string, unknown> = {};
    if (probe.durationMs) patch.durationMs = probe.durationMs;

    // Волна (meta.waveform) — по капабилити профиля (spec.waveform), best-effort:
    // не получилась → файл живёт без волны (веб рисует обычный плеер)
    if (!spec.waveform) return patch;
    const capMs = VOICE_LIMITS.waveformMaxDurationMs;
    if (probe.durationMs != null && probe.durationMs > capMs) return patch; // длинным волна не нужна

    // Неизвестная длительность (webm из MediaRecorder без заголовка) — кап НЕ обходится:
    // декод ограничиваем -t капом, а реальную длительность добираем из самого PCM
    // (закрывает и «duration=Infinity» голосового на вебе)
    const limitSec = probe.durationMs == null ? capMs / 1000 : null;
    const wave = await this.computeWaveform(bins.ffmpeg, source, limitSec);
    if (wave && !wave.truncated) {
      patch.waveform = wave.peaks;
      if (probe.durationMs == null) patch.durationMs = wave.durationMs;
    }
    return patch;
  }

  /**
   * Волна голосового: децимация в 2 кГц mono s16 PCM во ВРЕМЕННЫЙ ФАЙЛ (execFF
   * возвращает stdout строкой — бинарный поток через него нельзя), RMS по
   * waveformBuckets корзинам, пик-нормировка 0..100. limitSec ограничивает декод
   * (файл неизвестной длительности); упёрся в лимит → truncated (волну не сохраняем).
   */
  private async computeWaveform(
    ffmpegBin: string,
    source: string,
    limitSec: number | null,
  ): Promise<{ peaks: number[]; durationMs: number; truncated: boolean } | null> {
    const out = path.join(os.tmpdir(), `sa6-wave-${randomUUID()}.pcm`);
    try {
      const args = [
        '-y',
        '-i', source,
        ...(limitSec != null ? ['-t', String(limitSec)] : []),
        '-ac', '1',
        '-ar', '2000',
        '-f', 's16le',
        out,
      ];
      await execFF(ffmpegBin, args);
      const buf = await fs.promises.readFile(out);
      const samples = Math.floor(buf.length / 2);
      if (!samples) return null;
      const durationMs = Math.round((samples / 2000) * 1000);
      const truncated = limitSec != null && samples >= Math.floor((limitSec - 0.5) * 2000);
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
      return { peaks: peaks.map((p) => Math.round((p / max) * 100)), durationMs, truncated };
    } catch (err) {
      this.logger.warn(`waveform: ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      await fs.promises.unlink(out).catch(() => undefined);
    }
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
