// Серверная обёртка Заметок: кладёт в клиентский провайдер неймспейс сервиса
// (`common` и `shell` ServiceMessages добавит сам). Слой стикеров, живущий на
// любой странице, берёт тот же словарь отдельным чанком — см. `i18n/LazyNamespace`.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function NotesLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="notes">{children}</ServiceMessages>;
}
