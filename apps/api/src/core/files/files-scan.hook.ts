import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as net from 'net';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage-driver';

/** Тип джоба антивирусного скана в реестре core/jobs. */
const FILES_SCAN_JOB = 'files.scan';

/**
 * Антивирусная проверка файлов (модель Discord: доставляем сразу, скан фоном;
 * найден вирус → выдача мгновенно блокируется в FilesService по scanStatus='infected').
 * Включается заданием CLAMAV_HOST (иначе no-op, scanStatus остаётся 'none') — контейнер
 * clamav опционален (docker compose --profile scan up -d). Протокол clamd INSTREAM по TCP.
 * Базовая гигиена (whitelist MIME, magic-bytes, blacklist расширений) — в FilesService.
 */
@Injectable()
export class FilesScanHook implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(FilesScanHook.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
  ) {}

  get enabled(): boolean {
    return !!process.env.CLAMAV_HOST;
  }

  private get host(): string {
    return process.env.CLAMAV_HOST as string;
  }

  private get port(): number {
    return Number(process.env.CLAMAV_PORT ?? 3310);
  }

  /** Попыток скана до dead-letter (транзиентная недоступность clamd). */
  private static readonly SCAN_MAX_ATTEMPTS = 6;

  onModuleInit(): void {
    if (!this.enabled) return;
    this.jobsRegistry.register(
      FILES_SCAN_JOB,
      (payload) => this.scan(String(payload.fileId)),
      {
        maxAttempts: FilesScanHook.SCAN_MAX_ATTEMPTS,
        // Аренда ОБЯЗАТЕЛЬНА и должна быть больше socket-таймаута INSTREAM (120с):
        // с дефолтом 60с reaper переклеймивал бы файл прямо во время скана 200-МБ потока
        // и отправлял бы его в clamd вторым потоком параллельно.
        leaseMs: 5 * 60 * 1000,
        // Прежний крон пересканировал каждые 5 минут очень долго; 30с-бэкофф давал ~7 минут.
        backoffBaseMs: 60_000,
        onDiscard: (payload) => this.markScanError(String(payload.fileId)),
      },
    );
  }

  /**
   * Джоб скана похоронен (в т.ч. reaper'ом): фиксируем терминальный scanStatus='error',
   * иначе файл навсегда остался бы 'pending' и бэкфилл поднимал бы его на каждом старте.
   */
  private async markScanError(fileId: string): Promise<void> {
    await this.db.fileObject.updateMany({
      where: { id: fileId, scanStatus: 'pending' },
      data: { scanStatus: 'error' },
    });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    void this.backfillScanJobs().catch((err) =>
      this.logger.warn(`scan backfill failed: ${String((err as Error)?.message ?? err)}`),
    );
  }

  /**
   * Поставить джоб скана — В ТОЙ ЖЕ транзакции, что и переход файла в ready
   * (complete/ingest). Инертен без CLAMAV_HOST. uniqueKey `fs:<id>` дедупит.
   */
  async enqueue(tx: Prisma.TransactionClient | null, fileId: string): Promise<void> {
    if (!this.enabled) return;
    await this.jobs.enqueue(tx, {
      type: FILES_SCAN_JOB,
      payload: { fileId },
      uniqueKey: `fs:${fileId}`,
    });
  }

  async scan(fileId: string): Promise<void> {
    const file = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!file || file.status !== 'ready' || file.scanStatus === 'clean' || file.scanStatus === 'infected'
      || file.scanStatus === 'error') return;

    await this.db.fileObject.updateMany({
      where: { id: fileId, status: 'ready' },
      data: { scanStatus: 'pending' },
    });

    let verdict: 'clean' | 'infected';
    let signature: string | undefined;
    try {
      const res = await this.instream(file.storageKey);
      verdict = res.infected ? 'infected' : 'clean';
      signature = res.signature;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ПУСТОЙ ответ — это оборванное соединение (clamd рестартовал / упёрся в MaxQueue),
      // т.е. ТРАНЗИЕНТ: его нельзя хоронить терминально, иначе всплеск загрузок оставит
      // пачку файлов навсегда неотсканированными. Терминален только осмысленный отказ.
      if (/unexpected/.test(message) && !/\(empty\)/.test(message)) {
        // clamd ОТВЕТИЛ, но отверг поток (напр. StreamMaxLength) — ретрай не поможет:
        // терминальный scanStatus='error' + discard (не инцидент, dead-letter не нужен).
        await this.db.fileObject.updateMany({
          where: { id: fileId, status: 'ready', scanStatus: 'pending' },
          data: { scanStatus: 'error' },
        });
        throw new JobDiscardError(`clamd отверг поток ${fileId}: ${message}`);
      }
      // Сетевая ошибка (clamd недоступен) — транзиентна: бросаем, движок ретраит с бэкоффом.
      throw err;
    }

    await this.db.fileObject.updateMany({
      where: { id: fileId },
      data: { scanStatus: verdict, ...(verdict === 'infected' ? { error: `virus: ${signature ?? 'FOUND'}` } : {}) },
    });

    if (verdict === 'infected') {
      this.events.emit('file.scan.infected', { fileId, name: file.name, signature }, 'files');
      try {
        await this.notifications.notify(file.uploaderId, 'files.scan.infected', { name: file.name });
      } catch {
        // уведомление best-effort
      }
      this.logger.warn(`Файл ${fileId} заражён (${signature}) — выдача заблокирована`);
    }
  }

  /**
   * Бэкфилл при старте: ready-файлы, застрявшие в scanStatus='pending' (потерянный
   * enqueue до перезапуска). uniqueKey + проверка существующих джобов дедупят.
   */
  private async backfillScanJobs(): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const rows: Array<{ id: string }> = await this.db.fileObject.findMany({
        where: {
          status: 'ready',
          scanStatus: 'pending',
          ...(cursor !== null ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 200,
        select: { id: true },
      });
      if (rows.length === 0) return;
      const keys = rows.map((r) => `fs:${r.id}`);
      // Только ЖИВЫЕ джобы (см. тот же приём в конвейере): терминальный джоб не должен
      // навсегда блокировать повторную постановку, а от безнадёжных файлов защищает
      // терминальный scanStatus='error' из markScanError.
      const existing = await this.db.job.findMany({
        where: {
          type: FILES_SCAN_JOB,
          uniqueKey: { in: keys },
          status: { in: ['available', 'executing'] },
        },
        select: { uniqueKey: true },
      });
      const have = new Set(existing.map((j) => j.uniqueKey));
      let enqueued = 0;
      for (const r of rows) {
        if (have.has(`fs:${r.id}`)) continue;
        await this.enqueue(null, r.id);
        enqueued++;
      }
      if (enqueued > 0) this.logger.log(`scan backfill: enqueued ${enqueued} job(s)`);
      cursor = rows[rows.length - 1].id;
      if (rows.length < 200) return;
    }
  }

  /**
   * clamd INSTREAM по TCP: 'zINSTREAM\0' → чанки с 4-байтным BE-префиксом длины →
   * нулевой терминатор (00 00 00 00) → ответ "stream: OK" | "stream: <sig> FOUND".
   */
  private instream(storageKey: string): Promise<{ infected: boolean; signature?: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };

      socket.setTimeout(120_000);
      socket.on('timeout', () => done(() => reject(new Error('clamd timeout'))));
      socket.on('error', (err) => done(() => reject(err)));
      socket.on('data', (d) => (response += d.toString('utf8')));
      socket.on('end', () => {
        const text = response.trim();
        if (/\bOK\b/.test(text) && !/FOUND/.test(text)) {
          done(() => resolve({ infected: false }));
        } else if (/FOUND/.test(text)) {
          const sig = /stream:\s*(.+?)\s+FOUND/.exec(text)?.[1];
          done(() => resolve({ infected: true, signature: sig }));
        } else {
          done(() => reject(new Error(`clamd unexpected: ${text || '(empty)'}`)));
        }
      });

      socket.on('connect', async () => {
        try {
          socket.write('zINSTREAM\0');
          const { stream } = await this.driver.getStream(storageKey);
          // Backpressure: если сокет забит (clamd читает медленнее диска), пауза до
          // 'drain' — иначе весь 200-МБ файл буферизуется в очереди сокета (RSS/OOM).
          stream.on('data', (chunk: Buffer) => {
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length, 0);
            socket.write(size);
            if (!socket.write(chunk)) {
              stream.pause();
              socket.once('drain', () => stream.resume());
            }
          });
          stream.on('end', () => {
            socket.write(Buffer.from([0, 0, 0, 0])); // терминатор потока
          });
          stream.on('error', (err) => done(() => reject(err)));
        } catch (err) {
          done(() => reject(err as Error));
        }
      });
    });
  }
}
