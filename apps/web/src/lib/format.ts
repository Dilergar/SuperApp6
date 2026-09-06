'use client';

// ============================================================
// Форматирование, которому нужен ЯЗЫК: месяцы прописью, «Сегодня», единицы.
//
// Числовые форматы (03.09.2026, 12 500,00) языка не требуют — они принадлежат
// РЕГИОНУ и живут чистыми функциями в lib/dates.ts и lib/wallet-format.ts.
// Здесь — только то, где есть слова, поэтому здесь и только здесь нужны хуки.
//
// Правило: НИ ОДНОГО `toLocaleDateString('ru-RU')` в страницах. Такая строка —
// это и язык, и регион сразу, зашитые навсегда; ровно из-за неё 103 места кода
// говорили по-русски независимо от того, что выбрал человек.
// ============================================================
import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { createFormatters, type Formatters } from '@superapp/i18n/format';
import type { Locale } from '@superapp/shared';
import { formatDayLabel, localDayKey, localToday } from './day-groups';

/**
 * Форматтеры для языка зрителя. Пояс НЕ задаём: браузер знает пояс устройства
 * сам, и время показывается в нём (модель Google Календаря).
 */
export function useFormatters(): Formatters {
  const locale = useLocale() as Locale;
  return useMemo(() => createFormatters(locale), [locale]);
}

/** `2026-09-03` → «Сегодня» / «Вчера» / «3 сентября» на языке зрителя. */
export function useDayLabel(): (ymd: string) => string {
  const locale = useLocale() as Locale;
  const t = useTranslations('common');
  return useMemo(() => {
    const words = { today: t('day.today'), yesterday: t('day.yesterday') };
    return (ymd: string) => formatDayLabel(ymd, locale, words);
  }, [locale, t]);
}

/** Единицы размера файла из каталога — для `formatBytes`. */
export function useByteUnits(): { b: string; kb: string; mb: string; gb: string } {
  const t = useTranslations('common');
  return useMemo(
    () => ({ b: t('units.b'), kb: t('units.kb'), mb: t('units.mb'), gb: t('units.gb') }),
    [t],
  );
}

export { localDayKey, localToday };
