// Серверная обёртка кабинета платформы: кладёт в клиентский провайдер неймспейсы
// кабинета (`platform`), тарифов (`entitlements`: подписи ключей и планов) и
// `circles` (карточка человека). Сам каркас — клиентский (свой токен, свой вход).
import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { PlatformShell } from '@/components/platform/PlatformShell';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceMessages ns={['platform', 'entitlements', 'circles', 'auth']}>
      <PlatformShell>{children}</PlatformShell>
    </ServiceMessages>
  );
}
