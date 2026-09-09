// Серверная обёртка Диктофона: кладёт в клиентский провайдер неймспейс сервиса
// (`common` и `shell` ServiceMessages добавит сам).

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function RecorderLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="recorder">{children}</ServiceMessages>;
}
