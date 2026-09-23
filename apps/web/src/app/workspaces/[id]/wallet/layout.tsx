// Серверная обёртка: каталоги кошелька организации.
// `circles` — люди карточками (PersonChip).
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceWalletLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['wallet', 'workspaces', 'circles']}>{children}</ServiceMessages>;
}
