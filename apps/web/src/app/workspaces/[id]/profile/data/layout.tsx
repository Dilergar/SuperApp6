import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// «Данные и сроки хранения» организации (core/lifecycle): слова раздела — `lifecycle`,
// шапка профиля — `workspaces`, замок тарифа — `entitlements`, карточки людей — `circles`,
// раздел выгрузок — `dataExports`.
// Вложенный ServiceMessages ЗАМЕНЯЕТ словарь (docs/i18n.md) — перечислены все неймспейсы поддерева.
export default function WorkspaceDataLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['workspaces', 'lifecycle', 'entitlements', 'circles', 'dataExports']}>{children}</ServiceMessages>;
}
