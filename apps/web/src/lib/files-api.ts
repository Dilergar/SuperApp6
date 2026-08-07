// ============================================================
// Files Engine — клиент загрузки/скачивания (контракт Slack v2:
// init → байты → complete). Оркестратор uploadFile сам выбирает
// транспорт: ≤25 МБ одним запросом через API, больше — S3 multipart
// по presigned-частям (части идут ГОЛЫМ axios БЕЗ Authorization —
// иначе заголовок ломает подпись S3).
// ============================================================

import axios from 'axios';
import { apiDelete, apiGet, apiPost, apiPut } from './api';
import { FILE_LIMITS } from '@superapp/shared';
import type {
  FileDownloadUrl,
  FileDto,
  FileInitResult,
  FilePartUrl,
  FileUsageDto,
} from '@superapp/shared';

export interface UploadOptions {
  /** 0..1 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Файл от имени организации (B2B) */
  ownerWorkspaceId?: string;
}

export async function initFile(input: {
  profile: string;
  name: string;
  size: number;
  mime: string;
  ownerWorkspaceId?: string;
}): Promise<FileInitResult> {
  return apiPost<FileInitResult>('/files', input);
}

export async function uploadFileContent(
  fileId: string,
  file: Blob,
  opts: UploadOptions = {},
): Promise<FileDto> {
  const fd = new FormData();
  fd.append('file', file, (file as File).name || 'file');
  return apiPut<FileDto>(`/files/${fileId}/content`, fd, {
    timeout: 0, // у инстанса глобальные 10с — загрузку они убьют
    signal: opts.signal,
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (opts.onProgress && e.total) opts.onProgress(e.loaded / e.total);
    },
  });
}

export async function createParts(fileId: string, partNumbers: number[]): Promise<FilePartUrl[]> {
  return apiPost<FilePartUrl[]>(`/files/${fileId}/parts`, { partNumbers });
}

/** Часть multipart — голым клиентом (без интерцепторов/Authorization) */
async function uploadPart(
  url: string,
  chunk: Blob,
  opts: { signal?: AbortSignal; onLoaded?: (bytes: number) => void },
): Promise<string> {
  const res = await axios.put(url, chunk, {
    timeout: 0,
    signal: opts.signal,
    headers: { 'Content-Type': 'application/octet-stream' },
    onUploadProgress: (e) => opts.onLoaded?.(e.loaded),
  });
  const etag = String(res.headers['etag'] ?? '').replace(/"/g, '');
  if (!etag) throw new Error('Хранилище не вернуло ETag части');
  return etag;
}

export async function completeFile(
  fileId: string,
  body?: { sha256?: string; parts?: Array<{ partNumber: number; etag: string }> },
): Promise<FileDto> {
  return apiPost<FileDto>(`/files/${fileId}/complete`, body ?? {});
}

export async function abortFile(fileId: string): Promise<void> {
  await apiPost(`/files/${fileId}/abort`, {});
}

export async function getFileMeta(fileId: string): Promise<FileDto> {
  return apiGet<FileDto>(`/files/${fileId}`);
}

export async function getDownloadUrl(fileId: string, variant?: string): Promise<FileDownloadUrl> {
  return apiGet<FileDownloadUrl>(`/files/${fileId}/download`, {
    params: variant ? { variant } : undefined,
  });
}

export async function deleteFile(fileId: string): Promise<void> {
  await apiDelete(`/files/${fileId}`);
}

export async function getFilesUsage(): Promise<FileUsageDto> {
  return apiGet<FileUsageDto>('/files/usage');
}

/**
 * Полный цикл загрузки одного файла с прогрессом и отменой.
 * Ошибка/отмена → abort intent'а (не копим uploading-строки).
 */
export async function uploadFile(file: File, profile: string, opts: UploadOptions = {}): Promise<FileDto> {
  const init = await initFile({
    profile,
    name: file.name || 'file',
    size: file.size,
    mime: file.type || 'application/octet-stream',
    ownerWorkspaceId: opts.ownerWorkspaceId,
  });
  const fileId = init.file.id;

  try {
    if (init.transport === 'api') {
      await uploadFileContent(fileId, file, opts);
      return await completeFile(fileId);
    }

    // multipart: режем Blob на части и грузим последовательно (простая и надёжная v1)
    const partSize = init.partSize ?? FILE_LIMITS.partSize;
    const partCount = init.partCount ?? Math.ceil(file.size / partSize);
    const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const urls = await createParts(fileId, numbers);
    const byNumber = new Map(urls.map((u) => [u.partNumber, u.url]));

    const parts: Array<{ partNumber: number; etag: string }> = [];
    let uploadedBefore = 0;
    for (const n of numbers) {
      const url = byNumber.get(n);
      if (!url) throw new Error(`Нет ссылки на часть ${n}`);
      const start = (n - 1) * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      const done = uploadedBefore;
      const etag = await uploadPart(url, chunk, {
        signal: opts.signal,
        onLoaded: (bytes) => {
          if (opts.onProgress && file.size) opts.onProgress(Math.min(1, (done + bytes) / file.size));
        },
      });
      uploadedBefore += chunk.size;
      parts.push({ partNumber: n, etag });
      opts.onProgress?.(Math.min(1, uploadedBefore / file.size));
    }
    return await completeFile(fileId, { parts });
  } catch (err) {
    abortFile(fileId).catch(() => undefined);
    throw err;
  }
}
