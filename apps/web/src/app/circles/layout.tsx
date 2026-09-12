// Серверная обёртка «Моего окружения»: кладёт неймспейс сервиса в клиентский
// провайдер (`common` и `shell` ServiceMessages добавляет всегда).
//
// Тот же неймспейс нужен КАЖДОЙ странице, которая рисует полную карточку
// человека (`PersonCard`/`StaffPersonCard`): её действия и подписи полей живут
// здесь. Компактный `PersonChip` слов не берёт — ему провайдер не нужен.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function CirclesLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['circles', 'entitlements']}>{children}</ServiceMessages>;
}
