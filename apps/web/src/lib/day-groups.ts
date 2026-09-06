// ============================================================
// Группировка лент по дню — общий web-util (Финансы + Хроника/Журнал и далее).
// ВАЖНО: ключ дня и подпись считаются по ЛОКАЛЬНОЙ дате зрителя. UTC-срез
// ISO-строки (createdAt.slice(0,10)) при локальных подписях «Сегодня/Вчера»
// раскидывал ночные события в чужой день и давал две секции «Сегодня».
//
// Пояс — УСТРОЙСТВА (модель Google): браузер знает его сам, поэтому в форматтер
// зона не передаётся. Слова («Сегодня», название месяца) приходят из каталога —
// см. `useDayLabel()` в lib/format.ts, который и зовут страницы.
// ============================================================
import { formatDate, formatDayKey } from '@superapp/i18n/format';
import { SOURCE_LOCALE, type Locale } from '@superapp/shared';

const DEVICE = { locale: SOURCE_LOCALE } as const;

/** Локальный YYYY-MM-DD (день, который видит пользователь, не UTC). */
export const localToday = (): string => formatDayKey(new Date(), DEVICE);

/** Локальный YYYY-MM-DD из ISO-таймстемпа — ключ группировки ленты по дню зрителя. */
export const localDayKey = (iso: string): string => formatDayKey(new Date(iso), DEVICE);

/** Подписи «Сегодня»/«Вчера» — из каталога `common.day.*` (их даёт вызывающий). */
export interface DayLabelWords {
  today: string;
  yesterday: string;
}

/**
 * YYYY-MM-DD → «Сегодня» / «Вчера» / «2 июля» (+год, если не текущий).
 *
 * Язык нужен ТОЛЬКО названию месяца и двум словам, поэтому они приходят
 * параметрами: функция остаётся чистой и тестируемой, а хук над ней —
 * `useDayLabel()` в lib/format.ts.
 */
export function formatDayLabel(ymd: string, locale: Locale, words: DayLabelWords): string {
  const today = localToday();
  if (ymd === today) return words.today;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (ymd === formatDayKey(y, DEVICE)) return words.yesterday;

  // День и месяц ПРОПИСЬЮ: порядок частей принадлежит языку, поэтому строку
  // собирает Intl. В ленте текущего года год — лишний шум, поэтому у него свой
  // стиль, а не вырезание четырёх цифр из готовой строки регуляркой.
  const sameYear = ymd.slice(0, 4) === today.slice(0, 4);
  return formatDate(ymd, { locale }, sameYear ? 'dayMonthLong' : 'long');
}
