import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Центр уведомлений — платформа, не сервис: в app-nav не добавляется (вход — колокольчик),
// но каталог `notifications` странице нужен (фильтры, имена сервисов).
export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="notifications">{children}</ServiceMessages>;
}
