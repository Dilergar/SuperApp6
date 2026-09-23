// Серверная обёртка: каталоги журнала безопасности организации (core/audit).
// `circles` — карточки людей (PersonChip), `keys` — BotChip, `entitlements` — окно тарифа.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function WorkspaceSecurityLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['audit', 'workspaces', 'circles', 'keys', 'entitlements']}>{children}</ServiceMessages>;
}
