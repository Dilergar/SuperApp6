// Серверная обёртка: каталоги главной организации.
// `approvals` + `sign` — стопка решений и окно подписи на главной, `staff` — подпись
// роли, `documents` — подача документа, `circles` — люди карточками (PersonChip).
// Главная — группа маршрутов `(home)`: иначе её словарь лежал бы в layout области
// и ехал бы на КАЖДУЮ страницу организации.
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceHomeLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['workspaces', 'approvals', 'sign', 'staff', 'documents', 'circles']}>{children}</ServiceMessages>;
}
