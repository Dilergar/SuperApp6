// Серверная обёртка: каталоги сотрудников и оргструктуры.
// `hr` — сроки и кадровая карточка, `documents` — подача документа, `entitlements` —
// шкала мест тарифа. `circles` не случайно: ростер рисует ту же карточку человека,
// что и «Моё окружение» (`StaffPersonCard`), и её подписи живут в этом неймспейсе.
//
// Вложенный провайдер ЗАМЕНЯЕТ словарь, а не дополняет (docs/i18n.md) — здесь
// перечислено всё, что нужно поддереву; каркас области рисуется выше и своё не теряет.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceMembersLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['staff', 'hr', 'documents', 'entitlements', 'circles', 'visibility']}>{children}</ServiceMessages>;
}
