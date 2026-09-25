// Дашборд «Данные»: словарь дашборда (`platformData`) и жизненного цикла (`lifecycle`:
// классы данных, сроки, заморозки) едут только сюда, а не на каждую страницу Кабинета.
import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { PLATFORM_NS } from '../namespaces';

export default function PlatformDataLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns={[...PLATFORM_NS, 'platformData', 'lifecycle']}>{children}</ServiceMessages>;
}
