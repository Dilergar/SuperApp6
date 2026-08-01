import type { IconName } from '@/components/ui/Icon';

/**
 * Иконка объекта: папка, класс содержимого или запасной лист.
 *
 * Форма аргумента намеренно структурная, а не `DriveNodeDto`: тем же правилом
 * рисуется гостевой список по ссылке наружу, где у объекта своя, урезанная форма.
 */
export function driveIcon(node: { kind: string; file?: { kind?: string | null } | null }): IconName {
  if (node.kind === 'folder') return 'folder';
  switch (node.file?.kind) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'mic';
    case 'document':
      return 'docs';
    default:
      return 'file';
  }
}

const KB = 1024;

export function humanSize(bytes: number): string {
  if (bytes < KB) return `${bytes} Б`;
  if (bytes < KB ** 2) return `${(bytes / KB).toFixed(1)} КБ`;
  if (bytes < KB ** 3) return `${(bytes / KB ** 2).toFixed(1)} МБ`;
  return `${(bytes / KB ** 3).toFixed(2)} ГБ`;
}

/** Короткая дата: сегодня — время, этот год — день и месяц, иначе с годом */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/** `2026-07` → «июль 2026» */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  const idx = Number(m) - 1;
  return `${MONTHS[idx] ?? m} ${y}`;
}
