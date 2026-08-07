'use client';

// ============================================================
// Загрузка на Диск: файлы и ЦЕЛЫЕ ПАПКИ перетаскиванием.
//
// Почему свой хук, а не общий useFileUpload: тому достаточно списка файлов, а Диску
// нужно знать, в какую папку класть каждый — при перетаскивании каталога структуру
// надо воспроизвести. Байты по-прежнему грузит движок (uploadFile из lib/files-api),
// здесь только оркестрация: создать папки → загрузить → положить узлы.
// ============================================================

import { useCallback, useRef, useState } from 'react';
import { uploadFile } from '@/lib/files-api';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { attachDriveFile, createDriveFolder } from '@/lib/drive-api';
import type { DriveSpaceRef } from '@superapp/shared';
import type { UploadItem } from '@/lib/hooks/useFileUpload';

/** Файл вместе с путём внутри перетащенной папки (пустой путь = корень выделения) */
interface PlannedFile {
  file: File;
  path: string[];
}

/**
 * ЛОВУШКА: readEntries отдаёт максимум 100 записей за вызов и НЕ сообщает, что есть
 * ещё. Однократный вызов молча загружает ровно первые сто файлов папки, и человек
 * узнаёт об этом сильно позже. Читаем, пока не придёт пустая пачка.
 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(out);
          return;
        }
        out.push(...batch);
        step();
      }, reject);
    };
    step();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Обойти перетащенное дерево и собрать плоский план «файл + путь» */
async function planEntry(entry: FileSystemEntry, path: string[], out: PlannedFile[]): Promise<void> {
  if (entry.isFile) {
    out.push({ file: await fileOf(entry as FileSystemFileEntry), path });
    return;
  }
  const dir = entry as FileSystemDirectoryEntry;
  const children = await readAllEntries(dir.createReader());
  for (const child of children) await planEntry(child, [...path, dir.name], out);
}

export interface DriveUploadOptions {
  ref: DriveSpaceRef;
  /** В какую папку класть (null — корень пространства) */
  parentId: string | null;
  onDone?: () => void;
}

export function useDriveUpload({ ref, parentId, onDone }: DriveUploadOptions) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  // Кэш созданных папок на время одной загрузки: «фото/2024/лето» не должно
  // создаваться заново для каждого файла внутри.
  const folderCache = useRef(new Map<string, string>());

  const patch = useCallback((localId: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...next } : i)));
  }, []);

  const ensureFolder = useCallback(
    async (path: string[]): Promise<string | null> => {
      let current = parentId;
      let key = '';
      for (const name of path) {
        key = key ? `${key}/${name}` : name;
        const cached = folderCache.current.get(key);
        if (cached) {
          current = cached;
          continue;
        }
        const folder = await createDriveFolder(ref, { parentId: current, name });
        folderCache.current.set(key, folder.id);
        current = folder.id;
      }
      return current;
    },
    [parentId, ref],
  );

  const runPlan = useCallback(
    async (plan: PlannedFile[]) => {
      if (!plan.length) return;
      folderCache.current.clear();
      const seeded: UploadItem[] = plan.map((p, i) => ({
        localId: `${Date.now()}-${i}-${p.file.name}`,
        name: p.path.length ? `${p.path.join('/')}/${p.file.name}` : p.file.name,
        size: p.file.size,
        progress: 0,
        status: 'uploading',
      }));
      setItems((prev) => [...prev, ...seeded]);

      for (let i = 0; i < plan.length; i++) {
        const { file, path } = plan[i];
        const item = seeded[i];
        const controller = new AbortController();
        aborts.current.set(item.localId, controller);
        try {
          const target = await ensureFolder(path);
          const uploaded = await uploadFile(file, 'drive_file', {
            signal: controller.signal,
            ownerWorkspaceId: ref.workspaceId,
            onProgress: (f) => patch(item.localId, { progress: Math.round(f * 100) }),
          });
          await attachDriveFile(ref, { parentId: target, fileId: uploaded.id });
          patch(item.localId, { status: 'done', progress: 100 });
        } catch (err) {
          const cancelled = controller.signal.aborted;
          patch(item.localId, {
            status: cancelled ? 'cancelled' : 'error',
            error: cancelled ? undefined : apiErrorMessage(err),
          });
          if (!cancelled) toastError(`${file.name}: ${apiErrorMessage(err)}`);
        } finally {
          aborts.current.delete(item.localId);
        }
      }
      onDone?.();
    },
    [ensureFolder, onDone, patch, ref],
  );

  /** Обычный выбор файлов (input / перетаскивание без папок) */
  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const plan = Array.from(files).map((file) => ({ file, path: [] as string[] }));
      void runPlan(plan);
    },
    [runPlan],
  );

  /**
   * Перетаскивание: если браузер отдал элементы файловой системы — обходим дерево и
   * повторяем структуру папок. Не отдал (старый браузер) — грузим плоско.
   */
  const addDrop = useCallback(
    async (dataTransfer: DataTransfer) => {
      const entries: FileSystemEntry[] = [];
      for (const item of Array.from(dataTransfer.items)) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      if (!entries.length) {
        addFiles(dataTransfer.files);
        return;
      }
      const plan: PlannedFile[] = [];
      for (const entry of entries) await planEntry(entry, [], plan);
      void runPlan(plan);
    },
    [addFiles, runPlan],
  );

  const cancel = useCallback((localId: string) => {
    aborts.current.get(localId)?.abort();
  }, []);

  const remove = useCallback((localId: string) => {
    setItems((prev) => prev.filter((i) => i.localId !== localId));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((i) => i.status === 'uploading'));
  }, []);

  return {
    items,
    addFiles,
    addDrop,
    cancel,
    remove,
    clearFinished,
    busy: items.some((i) => i.status === 'uploading'),
  };
}
