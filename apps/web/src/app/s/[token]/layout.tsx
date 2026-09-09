import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { ServiceMessages } from '@/i18n/ServiceMessages';

/**
 * Гостевая страница по ссылке наружу.
 *
 * noindex обязателен: адрес содержит секретный токен, и попадание страницы в
 * поисковый индекс означало бы публикацию того, чем поделились адресно.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('share');
  return {
    title: t('guest.pageTitle'),
    robots: { index: false, follow: false },
  };
}

export default function ShareLayout({ children }: { children: ReactNode }) {
  // `sign` — внешний подписант приходит именно сюда; словарь подписи ему нужен
  // весь (соглашения, способы, экран итога), а другого layout'а у него нет.
  // `share` — слова самой гостевой страницы: тупики ссылки, пароль, «кто вы».
  return <ServiceMessages ns={['sign', 'share']}>{children}</ServiceMessages>;
}
