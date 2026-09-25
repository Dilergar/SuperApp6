import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// «Мои данные»: согласия и квитанции — `consents`, архив данных целиком — `dataExports`.
// Вложенный ServiceMessages ЗАМЕНЯЕТ словарь профиля для страницы (docs/i18n.md): перечислены
// все неймспейсы, которые читает поддерево (`common` и `shell` добавляются всегда).
export default function MyDataLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['consents', 'dataExports']}>{children}</ServiceMessages>;
}
