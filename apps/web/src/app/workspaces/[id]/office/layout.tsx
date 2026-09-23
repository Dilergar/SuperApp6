// Серверная обёртка: каталоги Виртуального офиса.
// Комната встречи (`[roomId]`) кладёт свой набор — со словарём мессенджера и звонков.
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceOfficeLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['office', 'workspaces', 'circles']}>{children}</ServiceMessages>;
}
