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

/** Local YYYY-MM-DD (the date the user perceives, not UTC). */
export const localToday = (): string => new Intl.DateTimeFormat('en-CA').format(new Date());

/** YYYY-MM-DD → «Сегодня» / «Вчера» / «2 июля» (+год, если не текущий). */
export function formatDayLabel(iso: string): string {
  const today = localToday();
  if (iso === today) return 'Сегодня';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (iso === new Intl.DateTimeFormat('en-CA').format(y)) return 'Вчера';
  const d = new Date(`${iso}T00:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}
