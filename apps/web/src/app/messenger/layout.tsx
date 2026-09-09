// Серверная обёртка Мессенджера: кладёт в клиентский провайдер неймспейсы
// страницы. `circles` здесь потому, что лента рисует людей карточками
// (`PersonCard`), `tasks`/`calendar`/`finance` — потому что быстрые действия
// создают их прямо из чата, а `approvals` — потому что рич-карта заявки
// решается кнопками в самой ленте, `notes` — потому что сообщение уходит в заметку.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function MessengerLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceMessages ns={['messenger', 'circles', 'tasks', 'calendar', 'finance', 'approvals', 'notes', 'calls']}>
      {children}
    </ServiceMessages>
  );
}
