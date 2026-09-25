// Карточка 360 организации: панель «Данные» говорит словами жизненного цикла (классы, сроки).
import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { PLATFORM_NS } from '../../namespaces';

export default function PlatformWorkspaceLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={[...PLATFORM_NS, 'lifecycle']}>{children}</ServiceMessages>;
}
