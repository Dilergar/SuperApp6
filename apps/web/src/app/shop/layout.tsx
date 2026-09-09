// Сервер-layout Магазина: кладёт в клиентский провайдер неймспейсы страницы
// (`common` и `shell` ServiceMessages добавит сам). `circles` — потому что
// «Сотрудники магазина» и шеринг витрины рисуют карточку человека и её пикер.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function ShopLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['shop', 'circles']}>{children}</ServiceMessages>;
}
