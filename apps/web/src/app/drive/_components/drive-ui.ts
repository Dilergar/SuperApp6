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

// Размеры, короткие даты и месяц прописью переехали в общие хуки
// `useBytes` / `useShortDate` / `useMonthLabel` (`lib/format.ts`): здесь они
// были собраны своими руками с `'ru-RU'` и русскими именами месяцев — то есть
// язык и регион, зашитые навсегда.
