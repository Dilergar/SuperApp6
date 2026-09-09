import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ServiceMessages } from '@/i18n/ServiceMessages';

/**
 * Открытая страница проверки электронной подписи (ст. 61 Цифрового кодекса РК:
 * оператор ИС обязан предоставить средство проверки подписи всем желающим).
 *
 * Сюда приходит человек ИЗВНЕ — контрагент, которому прислали подписанный
 * документ, или проверяющий. Аккаунта у него нет и не должно быть.
 *
 * `noindex` — потому что адрес вида `/check/<actId>?k=<токен>` содержит токен
 * проверки конкретной подписи; сама по себе страница `/check` безобидна, но
 * правило проще держать одно на весь раздел.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('sign');
  return {
    title: t('check.pageTitle'),
    robots: { index: false, follow: false },
  };
}

export default function CheckLayout({ children }: { children: ReactNode }) {
  return <ServiceMessages ns="sign">{children}</ServiceMessages>;
}
