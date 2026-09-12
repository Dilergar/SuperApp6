// Серверная обёртка: кладёт в клиентский провайдер неймспейсы этой страницы
// (`common` и `shell` ServiceMessages добавляет всегда).

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['dashboard', 'approvals', 'workspaces', 'tasks', 'finance', 'circles', 'entitlements']}>{children}</ServiceMessages>;
}
