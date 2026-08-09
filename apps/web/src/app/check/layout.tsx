import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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
export const metadata: Metadata = {
  title: 'Проверка электронной подписи — SuperApp6',
  robots: { index: false, follow: false },
};

export default function CheckLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
