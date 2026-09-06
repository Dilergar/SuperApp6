import type { Metadata } from 'next';
import { Manrope } from 'next/font/google';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { pickNamespaces } from '@superapp/i18n';
import './globals.css';
import '@/components/ui/ui.css';
import { Providers } from './providers';
import { AppChrome } from '@/components/shell/AppChrome';
import { SIDEBAR_COOKIE } from '@/lib/app-nav';

// Единственный шрифт системы. next/font самохостит его на нашем origin — это и
// быстрее (нет запроса к Google на каждый заход), и совпадает с CSP, где
// font-src разрешает только 'self' (раньше @import тянул шрифты со стороны).
//
// `cyrillic-ext` — не украшение: казахские Ә Ғ Қ Ң Ө Ұ Ү Һ І живут именно в этом
// сабсете. Без него браузер подставлял бы под них СИСТЕМНЫЙ шрифт, и казахская
// строка ехала бы двумя разными гарнитурами прямо внутри слова.
const manrope = Manrope({
  subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell');
  return {
    title: t('app.title'),
    description: t('app.description'),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Состояние сайдбара читаем на сервере — первый кадр сразу правильный,
  // без «прыжка» ширины после гидратации.
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'collapsed';
  // Язык — тоже на сервере (cookie → Accept-Language → kk), поэтому первый кадр
  // после F5 приходит уже на нужном языке, без «моргания» с подменой строк.
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={manrope.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        {/*
          В браузер уезжают ТОЛЬКО общие неймспейсы каркаса. Свои слова каждый
          сервис добавляет сам в своём layout через <ServiceMessages ns="…">,
          иначе словарь всей платформы ехал бы на каждую страницу.
        */}
        <NextIntlClientProvider messages={pickNamespaces(messages as never, []) as never}>
          <Providers>
            <AppChrome defaultCollapsed={collapsed}>{children}</AppChrome>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
