// Серверная обёртка: каталоги Процессов.
// `circles` — люди карточками (PersonChip). Словарь Процессов крупный — поэтому только здесь.
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceProcessesLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['processes', 'workspaces', 'circles']}>{children}</ServiceMessages>;
}
