import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Секции профиля организации: политика уведомлений рисует имена сервисов и типов из
// каталога `notifications` — серверная обёртка кладёт его в клиентский провайдер.
//
// ЛОВУШКА: вложенный провайдер ЗАМЕНЯЕТ сообщения, а не дополняет их (docs/i18n.md).
// Поэтому здесь перечислены ВСЕ неймспейсы поддерева, а не только добавляемый:
// без `workspaces` карточка компании, реквизиты и юрлица показывали бы ключи.
export default function WorkspaceProfileSectionLayout({ children }: { children: ReactNode }) {
  // `counterparties` рядом с `workspaces`: основание подписи в реквизитах — одно
  // понятие на обе стороны договора, и слова к нему живут в неймспейсе
  // контрагентов. Вложенный ServiceMessages ЗАМЕНЯЕТ словарь, а не дополняет:
  // не назвав его здесь, форма получила бы ключ вместо слова.
  return <ServiceMessages ns={['workspaces', 'notifications', 'counterparties']}>{children}</ServiceMessages>;
}
