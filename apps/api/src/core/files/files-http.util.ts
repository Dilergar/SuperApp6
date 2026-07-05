import type { Request, Response } from 'express';
import { Logger } from '@nestjs/common';
import type { StorageStreamResult } from './storage/storage-driver';

const logger = new Logger('FilesHttp');

/**
 * Разбор заголовка Range: поддерживаем `bytes=a-b` и `bytes=a-` (то, что шлют
 * <video>/<audio>); суффиксную форму `bytes=-N` игнорируем → отдаём 200 целиком.
 */
export function parseRangeHeader(header: string | undefined): { start: number; end?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '') return null;
  const start = Number(s);
  const end = e === '' ? undefined : Number(e);
  if (!Number.isFinite(start) || (end !== undefined && (!Number.isFinite(end) || end < start))) return null;
  return { start, end };
}

export interface StreamHeaders {
  mime: string;
  disposition: string;
  cacheControl: string;
}

/**
 * Отдать поток из драйвера в HTTP-ответ: 200/206 + Content-Range + nosniff.
 * После начала стрима ошибки НЕ уходят в AllExceptionsFilter (заголовки посланы) —
 * рвём сокет, клиент увидит обрыв, не половину файла с 200 OK.
 */
export function sendStorageStream(
  res: Response,
  result: StorageStreamResult,
  ranged: boolean,
  headers: StreamHeaders,
): void {
  res.setHeader('Content-Type', headers.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', headers.disposition);
  res.setHeader('Cache-Control', headers.cacheControl);
  if (ranged) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${result.start}-${result.end}/${result.size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', String(result.end - result.start + 1));

  result.stream.on('error', (err) => {
    logger.warn(`stream error: ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });
  result.stream.pipe(res);
}

/**
 * Общий хвост раздачи байтов для raw- и public-роутов: разобрать Range, открыть поток
 * (opener получает диапазон и возвращает поток + заголовки), отдать 200/206, а диапазон
 * вне объекта → 416. Единый source of truth HTTP-инвариантов (nosniff/Content-Range/416).
 */
export async function serveStream(
  req: Request,
  res: Response,
  open: (range?: { start: number; end?: number }) => Promise<{ result: StorageStreamResult; headers: StreamHeaders }>,
): Promise<void> {
  const range = requestRange(req);
  try {
    const { result, headers } = await open(range ?? undefined);
    sendStorageStream(res, result, !!range, headers);
  } catch (err) {
    if (isRangeError(err)) {
      res.status(416).end();
      return;
    }
    throw err;
  }
}

/** Диапазон вне объекта / драйвер не смог → 416 (важно для перемотки видео) */
export function isRangeError(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === 'InvalidRange';
}

export function requestRange(req: Request): { start: number; end?: number } | null {
  return parseRangeHeader(req.headers.range as string | undefined);
}
