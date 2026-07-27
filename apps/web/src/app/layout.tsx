import type { Metadata } from 'next';
import { Manrope } from 'next/font/google';
import { cookies } from 'next/headers';
import './globals.css';
import '@/components/ui/ui.css';
import { Providers } from './providers';
import { AppChrome } from '@/components/shell/AppChrome';
import { SIDEBAR_COOKIE } from '@/lib/app-nav';

// Единственный шрифт системы. next/font самохостит его на нашем origin — это и
// быстрее (нет запроса к Google на каждый заход), и совпадает с CSP, где
// font-src разрешает только 'self' (раньше @import тянул шрифты со стороны).
const manrope = Manrope({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SuperApp6 — Одно приложение для всего',
  description: 'SuperApp6 объединяет задачи, календарь, финансы и рабочие инструменты в одном аккаунте',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Состояние сайдбара читаем на сервере — первый кадр сразу правильный,
  // без «прыжка» ширины после гидратации.
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'collapsed';

  return (
    <html lang="ru" className={manrope.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>
          <AppChrome defaultCollapsed={collapsed}>{children}</AppChrome>
        </Providers>
      </body>
    </html>
  );
}
