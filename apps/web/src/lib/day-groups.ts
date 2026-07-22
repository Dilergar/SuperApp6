// ============================================================
// Группировка лент по дню — общий web-util (Финансы + Хроника/Журнал и далее).
// ВАЖНО: ключ дня и подпись считаются по ЛОКАЛЬНОЙ дате зрителя. UTC-срез
// ISO-строки (createdAt.slice(0,10)) при локальных подписях «Сегодня/Вчера»
// раскидывал ночные события в чужой день и давал две секции «Сегодня».
// ============================================================

/** Локальный YYYY-MM-DD (день, который видит пользователь, не UTC). */
export const localToday = (): string => new Intl.DateTimeFormat('en-CA').format(new Date());

/** Локальный YYYY-MM-DD из ISO-таймстемпа — ключ группировки ленты по дню зрителя. */
export const localDayKey = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA').format(new Date(iso));

/** YYYY-MM-DD → «Сегодня» / «Вчера» / «2 июля» (+год, если не текущий). */
export function formatDayLabel(ymd: string): string {
  const today = localToday();
  if (ymd === today) return 'Сегодня';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (ymd === new Intl.DateTimeFormat('en-CA').format(y)) return 'Вчера';
  const d = new Date(`${ymd}T00:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
