// Серверная обёртка области организации: кладёт в клиентский провайдер
// неймспейсы, которые нужны её страницам.
//
// `circles` здесь не случайно: ростер сотрудников рисует ту же карточку
// человека, что и «Моё окружение» (`StaffPersonCard`), а её действия и подписи
// полей живут в этом неймспейсе.
//
// Сам каркас области — клиентский (адрес организации, проверка входа), поэтому
// он вынесен в `workspace-chrome.tsx`: `ServiceMessages` обязан выполняться на
// сервере (см. `app/profile/`).

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { WorkspaceChrome } from './workspace-chrome';

export default function WorkspaceAreaLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceMessages
      ns={[
        'workspaces',
        'circles',
        'approvals',
        'tasks',
        'drive',
        'notes',
        'sign',
        'processes',
        'hr',
        'documents',
        'counterparties',
        'objects',
        'staff',
        'wallet',
        'office',
        'calls',
        'share',
      ]}
    >
      <WorkspaceChrome>{children}</WorkspaceChrome>
    </ServiceMessages>
  );
}
