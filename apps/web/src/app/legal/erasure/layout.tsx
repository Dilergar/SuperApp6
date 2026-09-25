import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Квитанция стирания (core/lifecycle) — публичная, без аккаунта: слова страницы и названия
// классов данных сертификата живут в неймспейсе движка. Вложенный словарь ЗАМЕНЯЕТ словарь
// раздела (`consents`) — странице он не нужен.
export default function ErasureReceiptLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="lifecycle">{children}</ServiceMessages>;
}
