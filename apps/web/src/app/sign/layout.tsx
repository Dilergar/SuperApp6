// Серверная обёртка личного подписания: кладёт в клиентский провайдер словарь
// движка подписи (`common` и `shell` ServiceMessages добавит сам). Рабочая
// заявка живёт по адресу организации — там неймспейс даёт layout `workspaces/[id]`.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function SignLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['sign', 'circles']}>{children}</ServiceMessages>;
}
