import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { ProfileChrome } from './profile-chrome';

// Серверная обёртка: она (и только она) кладёт каталог `profile` в клиентский
// провайдер. Сам каркас профиля — клиентский (адрес секции, выход), поэтому он
// живёт отдельным файлом: `ServiceMessages` обязан выполняться на сервере.
export default function ProfileLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceMessages ns={['profile', 'notifications', 'circles', 'wallet', 'share', 'entitlements', 'keys', 'consents', 'visibility']}>
      <ProfileChrome>{children}</ProfileChrome>
    </ServiceMessages>
  );
}
