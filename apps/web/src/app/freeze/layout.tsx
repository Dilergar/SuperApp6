import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

// Экстренная заморозка без входа — страница семьи auth: свой каталог `auth` и больше ничего
// (человек с украденным телефоном открывает её с чужого устройства, лишнее грузить незачем).
export default function FreezeLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="auth">{children}</ServiceMessages>;
}
