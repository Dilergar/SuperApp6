// Серверная обёртка: каталоги документооборота (+ЭДО, КЭДО).
// `hr` — кадровые блоки и кампании, `approvals` + `sign` — маршрут и подпись,
// `counterparties` — вторая сторона, `notes` — заметки к документу, `messenger` —
// «Поделиться в чат» (`ShareCardModal`), `circles` — люди карточками (PersonChip).
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceDocumentsLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['documents', 'hr', 'approvals', 'sign', 'counterparties', 'notes', 'messenger', 'circles']}>{children}</ServiceMessages>;
}
