import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { pickNamespaces } from '@superapp/i18n';
import type { ReactNode } from 'react';

// ============================================================
// Правило неймспейсов страницы.
//
// Каталог платформы — это сотни фраз всех сервисов. Если положить его в
// клиентский провайдер целиком, он поедет RSC-пейлоадом на КАЖДУЮ страницу:
// человек, открывший задачи, будет качать словарь КЭДО, Процессов и Диска.
//
// Поэтому серверный layout сервиса оборачивает своих детей вот этим и называет
// СВОИ неймспейсы; `common` и `shell` добавляются всегда (их знает каркас).
//
//   // app/tasks/layout.tsx
//   export default function Layout({ children }: { children: ReactNode }) {
//     return <ServiceMessages ns="tasks">{children}</ServiceMessages>;
//   }
//
// Серверные компоненты внутри при этом видят ВЕСЬ каталог (getTranslations
// читает конфигурацию запроса) — ограничение касается только того, что уезжает
// в браузер.
// ============================================================

export async function ServiceMessages({
  ns,
  children,
}: {
  /** Неймспейсы этого сервиса — один или несколько. */
  ns: string | readonly string[];
  children: ReactNode;
}) {
  const messages = await getMessages();
  const wanted = typeof ns === 'string' ? [ns] : ns;
  return (
    <NextIntlClientProvider messages={pickNamespaces(messages as never, wanted) as never}>
      {children}
    </NextIntlClientProvider>
  );
}
