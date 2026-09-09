import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { IntlProvider } from 'use-intl';
import { loadMessages } from '@superapp/i18n';
import { useLocaleStore } from './locale';

// ============================================================
// Каталоги мобильного клиента.
//
// Экраны здесь ЖИВУТ В ОДНОМ бандле, поэтому правила «неймспейс на страницу»
// (оно про RSC-пейлоад веба) у mobile нет: провайдер один на приложение и берёт
// ровно те неймспейсы, слова которых показывают экраны. Новый экран = плюс один
// неймспейс здесь, а не отдельная обвязка.
//
// Часовой пояс не задаём: время показывается в поясе УСТРОЙСТВА (модель
// Google Календаря) — ровно как в вебе.
// ============================================================

const NAMESPACES = ['common', 'shell', 'auth', 'dashboard', 'tasks', 'calendar', 'circles', 'profile'] as const;

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useLocaleStore((s) => s.locale);
  const messages = useMemo(() => loadMessages(locale, NAMESPACES), [locale]);
  return (
    <IntlProvider
      locale={locale}
      messages={messages}
      onError={(error) => {
        if (__DEV__) console.error(`[i18n] ${error.message}`);
      }}
      getMessageFallback={({ key, namespace }) => (namespace ? `${namespace}.${key}` : key)}
    >
      {children}
    </IntlProvider>
  );
}
