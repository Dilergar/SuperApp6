// Серверная обёртка редактора офисного документа (core/docs): страница живёт вне
// каркаса приложения (полноэкранный iframe), поэтому свой словарь она кладёт сама.

import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={['docs', 'share']}>{children}</ServiceMessages>;
}
