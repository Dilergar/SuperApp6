// Серверная обёртка Календаря: кладёт в клиентский провайдер неймспейсы этой
// страницы. `tasks` здесь не лишний — на сетке живёт СЛОЙ задач (карточка срока
// и её статус рисуются словами Задачника), а `common`/`shell` ServiceMessages
// добавляет всегда.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function CalendarLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['calendar', 'tasks']}>{children}</ServiceMessages>;
}
