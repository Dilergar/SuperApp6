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
import { createFormatters, formatBytes, type Formatters } from '@superapp/i18n/format';
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

/**
 * Обратный отсчёт «м:сс» — чистые цифры, ни языка, ни региона (кулдаун доходит
 * до 120, и «0:120» выглядело бы поломкой). Одна точка на оба экрана кода: свой
 * шаг подтверждения и гостевой вход по ссылке.
 */
export function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Единицы размера файла из каталога — для `formatBytes`. */
export function useByteUnits(): { b: string; kb: string; mb: string; gb: string } {
  const t = useTranslations('common');
  return useMemo(
    () => ({ b: t('units.b'), kb: t('units.kb'), mb: t('units.mb'), gb: t('units.gb') }),
    [t],
  );
}

/**
 * Размер файла словами языка и правилами региона: «1,4 МБ» / «1.4 MB».
 * Свой `${(b/1024).toFixed(1)} КБ` был и языком, и регионом сразу.
 */
export function useBytes(): (bytes: number) => string {
  const locale = useLocale() as Locale;
  const units = useByteUnits();
  return useMemo(() => (bytes: number) => formatBytes(bytes, { locale }, units), [locale, units]);
}

/**
 * Короткая отметка времени в списках: сегодня — часы, этот год — день и месяц,
 * иначе с годом. Даты собираются форматтерами языка, а не `'ru-RU'`.
 */
export function useShortDate(): (iso: string) => string {
  const f = useFormatters();
  return useMemo(
    () => (iso: string) => {
      const d = new Date(iso);
      const now = new Date();
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameDay) return f.time(d);
      return d.getFullYear() === now.getFullYear() ? f.date(d, 'dayMonthLong') : f.date(d, 'long');
    },
    [f],
  );
}

/** `2026-07` → «июль 2026» / «July 2026» — месяц прописью на языке зрителя. */
export function useMonthLabel(): (month: string) => string {
  const f = useFormatters();
  return useMemo(
    () => (month: string) => {
      const [y, m] = month.split('-');
      const idx = Number(m) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx > 11) return month;
      return `${f.month(new Date(Number(y), idx, 1))} ${y}`;
    },
    [f],
  );
}

/**
 * «480» минут → «8 ч» / «7,5 ч» / «7.5 h»: число — правилами региона, единица —
 * словом каталога. Округление до целого часа врало на полсмены, поэтому дробь
 * остаётся — но собирает её форматтер, а не `toFixed(1).replace('.', ',')`.
 */
export function useHoursLabel(): (minutes: number) => string {
  const f = useFormatters();
  const t = useTranslations('common');
  return useMemo(
    () => (minutes: number) => `${f.number(minutes / 60, { maximumFractionDigits: 1 })} ${t('units.hourShort')}`,
    [f, t],
  );
}

export { localDayKey, localToday };
