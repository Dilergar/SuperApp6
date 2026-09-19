import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Публичная витрина документов платформы (core/consents): доступна без аккаунта — на неё
// ведут ссылки из оферты, писем и уведомлений. Текст документа — контент из БД, не каталог.
export default function LegalLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="consents">{children}</ServiceMessages>;
}
