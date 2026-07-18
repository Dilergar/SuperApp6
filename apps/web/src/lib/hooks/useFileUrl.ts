'use client';

import { useQuery } from '@tanstack/react-query';
import { FILE_LIMITS } from '@superapp/shared';
import type { FileDto } from '@superapp/shared';
import { fileMetaKey, fileUrlKey } from '../queries';
import { getDownloadUrl, getFileMeta } from '../files-api';

/** Кэшируем чуть меньше TTL подписи — ссылка в кэше никогда не протухшая */
const URL_STALE_MS = Math.max(30_000, FILE_LIMITS.urlTtlSec * 1000 - 60_000);

/**
 * Ссылка на приватный файл/вариант: дергает GET /files/:id/download и кэширует
 * до истечения подписи. Для <img src>/<video src> — ссылки работают без JWT.
 */
export function useFileUrl(
  fileId: string | null | undefined,
  variant?: 'thumb' | 'medium' | 'poster',
) {
  const query = useQuery({
    queryKey: fileUrlKey(fileId ?? 'none', variant),
    queryFn: () => getDownloadUrl(fileId as string, variant),
    enabled: !!fileId,
    staleTime: URL_STALE_MS,
    gcTime: URL_STALE_MS,
    refetchOnWindowFocus: false,
  });
  return { url: query.data?.url ?? null, isLoading: query.isLoading, error: query.error as Error | null };
}

/**
 * Полные метаданные файла (с вариантами) — для рендера вложений чата/задач,
 * где в payload только снимок {fileId,name,kind,size}. FileObject после ready
 * иммутабелен → кэшируем навсегда: переоткрытие чата через минуту не повторяет
 * весь шторм meta-запросов. `opts.enabled=false` не дергает сеть вовсе
 * (вложение с живым серверным view рисуется без meta).
 */
export function useFileMeta(fileId: string | null | undefined, opts?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: fileMetaKey(fileId ?? 'none'),
    queryFn: () => getFileMeta(fileId as string),
    enabled: !!fileId && (opts?.enabled ?? true),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return { meta: query.data ?? null, isLoading: query.isLoading, error: query.error as Error | null };
}

/**
 * Отображаемый URL файла: публичный класс → вечная ссылка (кэшируется браузером,
 * подпись не нужна), приватный → подписанная ссылка через useFileUrl.
 */
export function useFileDisplayUrl(
  file: Pick<FileDto, 'id' | 'publicUrl' | 'variants'> | null | undefined,
  variant?: 'thumb' | 'medium' | 'poster',
  opts?: { fallbackToOriginal?: boolean; enabled?: boolean },
) {
  // enabled=false — вообще без сети и без URL (у вызывающего есть готовая view-ссылка);
  // хук всё равно вызывается безусловно — никаких conditional hooks у потребителей
  const enabled = opts?.enabled ?? true;
  const fallback = opts?.fallbackToOriginal ?? true;
  const hasVariant = variant ? !!file?.variants?.some((v) => v.kind === variant) : true;
  const effectiveVariant = variant && hasVariant ? variant : undefined;
  // Вариант запрошен, но его нет, а фолбэк на оригинал запрещён (напр. постер видео:
  // без него нельзя показывать сырое видео в <img> — тянется весь файл) → ничего.
  const missingRequired = !!variant && !hasVariant && !fallback;
  const isPublic = !!file?.publicUrl;
  const { url, isLoading } = useFileUrl(
    !enabled || !file || isPublic || missingRequired ? null : file.id,
    effectiveVariant,
  );
  if (!enabled || !file || missingRequired) return { url: null, isLoading: false };
  if (isPublic) {
    const suffix = effectiveVariant ? `?variant=${effectiveVariant}` : '';
    return { url: `${file.publicUrl}${suffix}`, isLoading: false };
  }
  return { url, isLoading };
}
