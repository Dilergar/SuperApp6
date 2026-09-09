// Серверная обёртка: кладёт в клиентский провайдер неймспейсы этой страницы
// (`common` и `shell` ServiceMessages добавляет всегда).

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function MyDocumentsLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['approvals', 'circles', 'hr']}>{children}</ServiceMessages>;
}
