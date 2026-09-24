// Серверная обёртка: каталоги справочника контрагентов.
// `documents` — документы контрагента, `notes` — заметки к нему, `messenger` —
// «Поделиться в чат» (`ShareCardModal`), `workspaces` — реквизиты своей стороны,
// `circles` — люди карточками (PersonChip).
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceCounterpartiesLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['counterparties', 'documents', 'notes', 'messenger', 'workspaces', 'circles', 'visibility']}>{children}</ServiceMessages>;
}
