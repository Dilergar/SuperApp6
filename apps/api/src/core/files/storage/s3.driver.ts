import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import type { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { MultipartPart, PresignOptions, StorageDriver, StorageStreamResult } from './storage-driver';

/**
 * Любое S3-совместимое хранилище через AWS SDK v3 (dev/self-host: SeaweedFS из
 * docker-compose профиля `s3`; прод: тот же SeaweedFS на KZ-сервере или облако —
 * смена бэкенда = env). Приватное чтение — presigned GET, байты минуют API.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  readonly supportsMultipart = true;

  private readonly logger = new Logger(S3StorageDriver.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string | null;
  private bucketEnsured = false;

  constructor() {
    this.bucket = process.env.S3_BUCKET as string;
    this.publicBase = process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, '') || null;
    this.client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
      },
      // Таймауты обязательны: своих у SDK НЕТ вовсе, и зависшее соединение к хранилищу
      // висит вечно. Для фоновых джобов это отдельно опасно — скачивание байт течёт
      // внутри аренды, поэтому «вечное» ожидание = переклейм reaper'ом и вторая
      // параллельная тяжёлая работа (расшифровка/конвейер). requestTimeout — это простой
      // сокета БЕЗ данных, а не общий потолок, так что медленную, но живую загрузку
      // 200-МБ файла он не рвёт.
      requestHandler: {
        connectionTimeout: 10_000,
        requestTimeout: 120_000,
      },
    });
    // Dev-удобство: пробуем создать бакет (ошибка не валит процесс — прод-бакет создают руками)
    void this.ensureBucket();
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketEnsured = true;
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.bucketEnsured = true;
        this.logger.log(`Создан бакет "${this.bucket}"`);
      } catch (err) {
        this.logger.warn(
          `Бакет "${this.bucket}" недоступен и не создался: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  async putFromFile(key: string, sourcePath: string, mime: string): Promise<void> {
    await this.ensureBucket();
    const stat = await fs.promises.stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(sourcePath),
        ContentLength: stat.size,
        ContentType: mime,
      }),
    );
    await fs.promises.unlink(sourcePath).catch(() => undefined);
  }

  async getStream(key: string, range?: { start: number; end?: number }): Promise<StorageStreamResult> {
    const rangeHeader = range ? `bytes=${range.start}-${range.end ?? ''}` : undefined;
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: rangeHeader }),
    );
    const body = res.Body as Readable;
    if (!body) throw new Error(`Пустое тело объекта ${key}`);
    if (range) {
      // ContentRange: "bytes start-end/total"
      const m = /bytes\s+(\d+)-(\d+)\/(\d+)/.exec(res.ContentRange ?? '');
      if (m) {
        return { stream: body, size: Number(m[3]), start: Number(m[1]), end: Number(m[2]) };
      }
      // Хранилище проигнорировало Range — отдаём как полный объект
      const total = Number(res.ContentLength ?? 0);
      return { stream: body, size: total, start: 0, end: Math.max(total - 1, 0) };
    }
    const size = Number(res.ContentLength ?? 0);
    // end=-1 для пустого объекта → Content-Length (end-start+1)=0, а не ложная 1
    return { stream: body, size, start: 0, end: size - 1 };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return Number(res.ContentLength ?? 0);
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey' || name === '404') return null;
      throw err;
    }
  }

  async presignedGet(key: string, ttlSec: number, opts?: PresignOptions): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: opts?.disposition,
      ResponseContentType: opts?.mime,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSec });
  }

  localPath(): string | null {
    return null;
  }

  publicObjectUrl(key: string): string | null {
    return this.publicBase ? `${this.publicBase}/${key}` : null;
  }

  async createMultipart(key: string, mime: string): Promise<string> {
    await this.ensureBucket();
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: mime }),
    );
    if (!res.UploadId) throw new Error('S3 не вернул UploadId');
    return res.UploadId;
  }

  async presignPart(key: string, uploadId: string, partNumber: number, ttlSec: number): Promise<string> {
    const cmd = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSec });
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      this.logger.warn(`abortMultipart(${key}): ${err instanceof Error ? err.message : err}`);
    }
  }
}
