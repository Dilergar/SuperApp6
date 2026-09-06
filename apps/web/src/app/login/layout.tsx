import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Правило неймспейсов страницы: в браузер уезжают только `common`, `shell` и
// свои. Каталог остальных сервисов экрану входа не нужен — и не должен его
// замедлять.
export default function AuthRouteLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="auth">{children}</ServiceMessages>;
}
