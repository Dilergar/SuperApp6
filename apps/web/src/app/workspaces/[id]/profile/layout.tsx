// Серверная обёртка профиля организации: словарь боковой колонки разделов
// (`workspaces.profile.*`). Сама колонка — клиентская (адрес раздела, роль), поэтому
// живёт в `profile-chrome.tsx`: `ServiceMessages` обязан выполняться на сервере.
// Секции (`[section]/layout.tsx`) кладут свой, более широкий набор.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { WorkspaceProfileChrome } from './profile-chrome';

export default function WorkspaceProfileLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceMessages ns={['workspaces', 'visibility']}>
      <WorkspaceProfileChrome>{children}</WorkspaceProfileChrome>
    </ServiceMessages>
  );
}
