// Мелкие утилиты отображения файлов — одна точка правды для иконок/размеров.

import { fileKindFromMime, type FileDto } from '@superapp/shared';

export function fileIcon(kindOrMime: string): string {
  // MIME → класс через shared (одна классификация с бэкендом, без дрейфа); либо готовый kind
  const k = kindOrMime.includes('/') ? fileKindFromMime(kindOrMime) : kindOrMime;
  switch (k) {
    case 'image':
      return '🖼️';
    case 'video':
      return '🎬';
    case 'audio':
      return '🎵';
    case 'document':
      return '📄';
    default:
      return '📦';
  }
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let v = bytes / 1024;
  for (const u of units) {
    if (v < 1024) return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} ТБ`;
}

/** m:ss, часовые записи — h:mm:ss (Диктофон пишет до часа и дольше) */
export function formatDuration(ms: number | undefined | null): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function hasVariant(file: Pick<FileDto, 'variants'>, kind: string): boolean {
  return !!file.variants?.some((v) => v.kind === kind);
}
