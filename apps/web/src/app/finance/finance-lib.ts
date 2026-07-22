// ============================================================
// Финансы — money helpers shared by the finance UI
// ============================================================

const SYMBOLS: Record<string, string> = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽' };

export const currencySymbol = (code: string): string => SYMBOLS[code] ?? code;

/** Minor units → "12 500,50 ₸" (trailing zero kopecks are dropped). */
export function formatMoney(minor: number, code: string): string {
  const major = minor / 100;
  const hasCents = Math.abs(major % 1) > 1e-9;
  return `${major.toLocaleString('ru-RU', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })} ${currencySymbol(code)}`;
}

/** "2 500,50" / "2500.5" → 250050 minor units; null when not a positive number. */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/** Same as parseMoneyInput but allows 0 and negatives (для корректировки остатка). */
export function parseSignedMoneyInput(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Короткие дни недели (1=пн … 7=вс) — повторы, «Обзор». */
export const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** axios-config с bookId для запросов в чужую книгу. */
export const bookParams = (bookId: string | null | undefined) => (bookId ? { params: { bookId } } : undefined);

// Группировка по дню — общий web-util (lib/day-groups): переиспользуется Хроникой/Журналом.
export { localToday, formatDayLabel } from '@/lib/day-groups';
