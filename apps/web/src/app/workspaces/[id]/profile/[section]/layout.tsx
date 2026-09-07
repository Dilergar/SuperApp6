import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Секции профиля организации: политика уведомлений рисует имена сервисов и типов из
// каталога `notifications` — серверная обёртка кладёт его в клиентский провайдер.
export default function WorkspaceProfileSectionLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="notifications">{children}</ServiceMessages>;
}
