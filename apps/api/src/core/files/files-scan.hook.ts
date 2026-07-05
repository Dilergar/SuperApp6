import { Inject, Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage-driver';

/**
 * Антивирусная проверка файлов (модель Discord: доставляем сразу, скан фоном;
 * найден вирус → выдача мгновенно блокируется в FilesService по scanStatus='infected').
 * Включается заданием CLAMAV_HOST (иначе no-op, scanStatus остаётся 'none') — контейнер
 * clamav опционален (docker compose --profile scan up -d). Протокол clamd INSTREAM по TCP.
 * Базовая гигиена (whitelist MIME, magic-bytes, blacklist расширений) — в FilesService.
 */
@Injectable()
export class FilesScanHook {
  private readonly logger = new Logger(FilesScanHook.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly notifications: NotificationsService,
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

  /** Сколько раз перескан по транзиентной ошибке (clamd недоступен), потом — terminal */
  private readonly maxRetries = 5;

  /** Поставить файл в очередь скана (fire-and-forget из complete/крона) */
  enqueue(fileId: string): void {
    if (!this.enabled) return;
    this.scan(fileId).catch((err) =>
      this.logger.warn(`scan ${fileId}: ${err instanceof Error ? err.message : err}`),
    );
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
      const meta = (file.meta as Record<string, unknown> | null) ?? {};
      const retries = (typeof meta.scanRetries === 'number' ? meta.scanRetries : 0) + 1;
      // clamd ОТВЕТИЛ, но отверг поток (напр. StreamMaxLength) — ретрай не поможет →
      // терминальный 'error'. Сетевая ошибка — транзиентна: pending до лимита попыток.
      const terminal = /unexpected/.test(message) || retries >= this.maxRetries;
      this.logger.warn(`clamd ${fileId} (retry ${retries}${terminal ? ', terminal' : ''}): ${message}`);
      await this.db.fileObject.updateMany({
        where: { id: fileId, status: 'ready', scanStatus: 'pending' },
        data: {
          meta: { ...meta, scanRetries: retries } as object,
          ...(terminal ? { scanStatus: 'error' } : {}),
        },
      });
      return;
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
