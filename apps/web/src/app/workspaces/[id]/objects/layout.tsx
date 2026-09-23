// Серверная обёртка: каталоги объектов (площадки, штат, смены, оборудование).
// `notes` — заметки к объекту, `entitlements` — замки тарифа, `circles` — люди карточками (PersonChip).
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceObjectsLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['objects', 'notes', 'entitlements', 'circles']}>{children}</ServiceMessages>;
}
