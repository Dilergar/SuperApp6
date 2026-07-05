import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { MultipartPart, PresignOptions, StorageDriver, StorageStreamResult } from './storage-driver';

/**
 * Локальный диск (dev-дефолт и малые установки; дефолт Mattermost/Nextcloud/Odoo).
 * Ключи вида `ab/cd/<uuid>[_variant.ext]` — двухуровневый шардинг, чтобы каталоги
 * не распухали. Долговечность = диск + бэкапы; второй app-сервер → переход на s3-драйвер.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  readonly supportsMultipart = false;

  private readonly logger = new Logger(LocalStorageDriver.name);
  private readonly root: string;

  constructor(root?: string) {
    this.root = path.resolve(process.cwd(), root ?? process.env.FILES_LOCAL_ROOT ?? './storage');
    fs.mkdirSync(path.join(this.root, 'tmp'), { recursive: true });
  }

  /** Временный каталог для multer/конвейера — тот же том, что и хранилище (rename дёшев) */
  tmpDir(): string {
    return path.join(this.root, 'tmp');
  }

  private fullPath(key: string): string {
    const resolved = path.resolve(this.root, key);
    // Ключи генерирует движок, но пояс безопасности не помешает
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new Error(`Недопустимый ключ хранилища: ${key}`);
    }
    return resolved;
  }

  async putFromFile(key: string, sourcePath: string, _mime: string): Promise<void> {
    const dest = this.fullPath(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.promises.rename(sourcePath, dest);
    } catch (err) {
      // Другой том (EXDEV) — копируем
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.promises.copyFile(sourcePath, dest);
        await fs.promises.unlink(sourcePath).catch(() => undefined);
      } else {
        throw err;
      }
    }
  }

  async getStream(key: string, range?: { start: number; end?: number }): Promise<StorageStreamResult> {
    const file = this.fullPath(key);
    const stat = await fs.promises.stat(file);
    const size = stat.size;
    // Пустой объект: отдаём пустой поток (Content-Length 0), а не 416 на обычный GET
    if (size === 0 && !range) {
      return { stream: fs.createReadStream(file), size: 0, start: 0, end: -1 };
    }
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    if (start < 0 || start > end || start >= size) {
      throw new RangeError(`Диапазон вне объекта (size=${size}, start=${start}, end=${end})`);
    }
    return { stream: fs.createReadStream(file, { start, end }), size, start, end };
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.promises.unlink(this.fullPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const stat = await fs.promises.stat(this.fullPath(key));
      return stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async presignedGet(_key: string, _ttlSec: number, _opts?: PresignOptions): Promise<string | null> {
    return null; // приватные ссылки выдаёт движок (HMAC-роут /files/raw/:id)
  }

  localPath(key: string): string {
    return this.fullPath(key);
  }

  publicObjectUrl(): string | null {
    return null; // локальный диск не раздаёт байты напрямую — движок стримит по токену
  }

  async createMultipart(): Promise<string> {
    throw new Error('Multipart-загрузка не поддерживается local-драйвером');
  }

  async presignPart(): Promise<string> {
    throw new Error('Multipart-загрузка не поддерживается local-драйвером');
  }

  async completeMultipart(_key: string, _uploadId: string, _parts: MultipartPart[]): Promise<void> {
    throw new Error('Multipart-загрузка не поддерживается local-драйвером');
  }

  async abortMultipart(): Promise<void> {
    // нечего отменять
  }
}
