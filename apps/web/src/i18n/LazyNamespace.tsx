'use client';

import { NextIntlClientProvider, useLocale, useMessages } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';

// ============================================================
// Неймспейс, доезжающий ОТДЕЛЬНЫМ чанком — для слоёв, живущих на любой странице.
//
// Правило `ServiceMessages` (словарь сервиса кладёт его собственный layout) не
// работает для того, у чего layout'а нет: слой стикеров Заметок монтируется в
// `Providers` и открывается по Alt+N где угодно. Класть его словарь в корневой
// провайдер значило бы возить ~200 фраз Заметок на КАЖДУЮ страницу.
//
// Поэтому каталог грузится динамическим импортом по первому открытию слоя:
// сборщик выделяет его в свой чанк, и до Alt+N он не скачивается вовсе.
// ============================================================

type Catalog = Record<string, unknown>;

/** Загрузчики по языку. Пути статические — иначе сборщик не увидит чанк. */
const LOADERS: Record<string, Record<string, () => Promise<{ default: Catalog }>>> = {
  notes: {
    en: () => import('@superapp/i18n/messages/en/notes.json'),
    kk: () => import('@superapp/i18n/messages/kk/notes.json'),
    ru: () => import('@superapp/i18n/messages/ru/notes.json'),
  },
  // Входящий звонок ловится на ЛЮБОЙ странице (CallsWatcher в Providers): свой
  // словарь модалка тянет чанком, а не возит его на каждую страницу.
  calls: {
    en: () => import('@superapp/i18n/messages/en/calls.json'),
    kk: () => import('@superapp/i18n/messages/kk/calls.json'),
    ru: () => import('@superapp/i18n/messages/ru/calls.json'),
  },
  // Подпись открывается из стопки «Ждут решения», а стопка живёт в каркасе —
  // то есть окно подписания может всплыть на любой странице платформы.
  sign: {
    en: () => import('@superapp/i18n/messages/en/sign.json'),
    kk: () => import('@superapp/i18n/messages/kk/sign.json'),
    ru: () => import('@superapp/i18n/messages/ru/sign.json'),
  },
};

export function LazyNamespace({ ns, children }: { ns: keyof typeof LOADERS; children: ReactNode }) {
  const locale = useLocale();
  const base = useMessages();
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    let alive = true;
    const byLocale = LOADERS[ns];
    const load = byLocale[locale] ?? byLocale.en;
    void load().then((m) => {
      if (alive) setCatalog(m.default ?? (m as unknown as Catalog));
    });
    return () => {
      alive = false;
    };
  }, [ns, locale]);

  // Пока словарь не приехал, слой не рисуем: мигать ключами вместо слов нельзя.
  if (!catalog) return null;
  return (
    <NextIntlClientProvider locale={locale} messages={{ ...(base as object), [ns]: catalog } as never}>
      {children}
    </NextIntlClientProvider>
  );
}
