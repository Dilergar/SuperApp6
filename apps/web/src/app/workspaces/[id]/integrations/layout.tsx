// Серверная обёртка: каталоги раздела «Интеграции и ключи» (core/keys, core/webhooks).
// `circles` — карточки людей (PersonChip), `entitlements` — замки тарифа.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function IntegrationsLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['keys', 'workspaces', 'circles', 'entitlements']}>{children}</ServiceMessages>;
}
