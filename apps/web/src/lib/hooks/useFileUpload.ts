'use client';

import { useCallback, useRef, useState } from 'react';
import type { FileDto } from '@superapp/shared';
import { uploadFile } from '../files-api';

export interface UploadItem {
  localId: string;
  name: string;
  size: number;
  /** 0..1 */
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
  file?: FileDto;
}

export interface UseFileUploadOptions {
  onUploaded?: (file: FileDto) => void;
  ownerWorkspaceId?: string;
}

/**
 * Очередь загрузок с прогрессом/отменой — переиспользуемый кирпич движка файлов
 * (как EntitySelector для людей): любой сервис получает загрузчик одним хуком.
 */
export function useFileUpload(profile: string, options?: UseFileUploadOptions) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const optsRef = useRef(options);
  optsRef.current = options;

  const patch = useCallback((localId: string, p: Partial<UploadItem>) => {
    setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...p } : i)));
  }, []);

  const add = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) {
        const localId = crypto.randomUUID();
        const ctrl = new AbortController();
        controllers.current.set(localId, ctrl);
        setItems((prev) => [
          ...prev,
          { localId, name: f.name || 'файл', size: f.size, progress: 0, status: 'uploading' },
        ]);
        uploadFile(f, profile, {
          signal: ctrl.signal,
          ownerWorkspaceId: optsRef.current?.ownerWorkspaceId,
          onProgress: (fraction) => patch(localId, { progress: fraction }),
        })
          .then((dto) => {
            patch(localId, { status: 'done', progress: 1, file: dto });
            optsRef.current?.onUploaded?.(dto);
          })
          .catch((err: { response?: { data?: { message?: string } }; message?: string }) => {
            if (ctrl.signal.aborted) {
              patch(localId, { status: 'cancelled' });
            } else {
              patch(localId, {
                status: 'error',
                error: err?.response?.data?.message ?? err?.message ?? 'Ошибка загрузки',
              });
            }
          })
          .finally(() => controllers.current.delete(localId));
      }
    },
    [profile, patch],
  );

  const cancel = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
  }, []);

  const remove = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    setItems((prev) => prev.filter((i) => i.localId !== localId));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((i) => i.status === 'uploading'));
  }, []);

  const busy = items.some((i) => i.status === 'uploading');
  return { items, add, cancel, remove, clearFinished, busy };
}
