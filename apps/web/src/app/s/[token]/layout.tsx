import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Гостевая страница по ссылке наружу.
 *
 * noindex обязателен: адрес содержит секретный токен, и попадание страницы в
 * поисковый индекс означало бы публикацию того, чем поделились адресно.
 */
export const metadata: Metadata = {
  title: 'Ссылка — SuperApp6',
  robots: { index: false, follow: false },
};

export default function ShareLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
