import type { Readable } from 'stream';

/**
 * Драйвер хранения байтов (паттерн Mattermost FileSettings.DriverName / Supabase
 * STORAGE_BACKEND): движок один, байт-стор заменяемый. Реализации: local (диск,
 * dev-дефолт и малые установки) и s3 (любое S3-совместимое: SeaweedFS/облако).
 * Ключи объектов генерирует движок из uuid — пользовательский ввод сюда не попадает.
 */

export const STORAGE_DRIVER = 'FILES_STORAGE_DRIVER';

export interface StorageStreamResult {
  stream: Readable;
  /** Полный размер объекта */
  size: number;
  /** Границы отдаваемого диапазона (включительно) */
  start: number;
  end: number;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface PresignOptions {
  /** Content-Disposition ответа (attachment; filename=...) */
  disposition?: string;
  /** Content-Type ответа */
  mime?: string;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';
  readonly supportsMultipart: boolean;

  /** Положить объект из локального временного файла */
  putFromFile(key: string, sourcePath: string, mime: string): Promise<void>;

  /** Поток чтения; range.end не задан → до конца объекта */
  getStream(key: string, range?: { start: number; end?: number }): Promise<StorageStreamResult>;

  /** Удалить объект (отсутствие — не ошибка) */
  delete(key: string): Promise<void>;

  /** Размер объекта или null, если объекта нет */
  size(key: string): Promise<number | null>;

  /**
   * Приватная ссылка на скачивание (presigned GET). null → драйвер не умеет,
   * движок выдаст HMAC-ссылку на собственный raw-роут.
   */
  presignedGet(key: string, ttlSec: number, opts?: PresignOptions): Promise<string | null>;

  /** Прямой путь на локальном диске (оптимизация конвейера); null для удалённых сторов */
  localPath(key: string): string | null;

  /**
   * Прямая вечная публичная ссылка на объект (CDN/бакет), если драйвер её умеет —
   * движок редиректит на неё публичные файлы. null → движок отдаст presigned/стрим.
   */
  publicObjectUrl(key: string): string | null;

  // --- multipart (только s3) ---
  createMultipart(key: string, mime: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, ttlSec: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}
