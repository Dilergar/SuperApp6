// ============================================================
// Время сервиса «Объекты» — В ПОЯСЕ ОБЪЕКТА.
//
// `new Date().toISOString().slice(0, 10)` даёт дату в UTC, а Казахстан — UTC+5:
// каждую ночь с 00:00 до 05:00 местного «сегодня» превращалось во вчера. Это те
// самые часы, когда работают точки, склады и охрана, поэтому дата и время смен
// считаются ТОЛЬКО через эти помощники.
// ============================================================

/** Пояс по умолчанию, если объект ещё не загружен (совпадает с APP_TIMEZONE). */
export const FALLBACK_TZ = 'Asia/Almaty';

/** Часовые пояса Казахстана — для выбора в форме объекта (ввод руками = опечатки). */
export const KZ_TIME_ZONES = [
  { value: 'Asia/Almaty', label: 'Алматы, Астана (UTC+5)' },
  { value: 'Asia/Aqtobe', label: 'Актобе (UTC+5)' },
  { value: 'Asia/Qostanay', label: 'Костанай (UTC+5)' },
  { value: 'Asia/Qyzylorda', label: 'Кызылорда (UTC+5)' },
  { value: 'Asia/Aqtau', label: 'Актау (UTC+5)' },
  { value: 'Asia/Atyrau', label: 'Атырау (UTC+5)' },
  { value: 'Asia/Oral', label: 'Уральск (UTC+5)' },
] as const;

function parts(iso: string | Date, timeZone: string): Record<string, string> {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

/** «Сегодня» (YYYY-MM-DD) в поясе объекта. */
export function todayIn(timeZone: string = FALLBACK_TZ): string {
  const p = parts(new Date(), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Текущий месяц (YYYY-MM) в поясе объекта. */
export function monthIn(timeZone: string = FALLBACK_TZ): string {
  return todayIn(timeZone).slice(0, 7);
}

/** Дата момента (YYYY-MM-DD) в поясе объекта. */
export function dateIn(iso: string, timeZone: string = FALLBACK_TZ): string {
  const p = parts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Время момента «09:05» в поясе объекта. */
export function timeIn(iso: string, timeZone: string = FALLBACK_TZ): string {
  const p = parts(iso, timeZone);
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

/** Минуты от полуночи местного дня — то, что ждёт сервер в `startMin`. */
export function minutesIn(iso: string, timeZone: string = FALLBACK_TZ): number {
  const p = parts(iso, timeZone);
  const h = Number(p.hour === '24' ? '00' : p.hour);
  return h * 60 + Number(p.minute);
}

/**
 * Местные «дата + ЧЧ:ММ» → момент UTC (ISO). Двухшаговое приближение смещения —
 * то же, что на сервере (`shift-time.ts`): переживает переход на летнее время.
 */
export function localToIso(dateISO: string, hhmm: string, timeZone: string = FALLBACK_TZ): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const naive = new Date(`${dateISO}T00:00:00.000Z`).getTime() + minutes * 60_000;
  let guess = new Date(naive);
  for (let i = 0; i < 2; i += 1) {
    const shown = new Date(`${dateIn(guess.toISOString(), timeZone)}T${timeIn(guess.toISOString(), timeZone)}:00.000Z`);
    guess = new Date(guess.getTime() + (naive - shown.getTime()));
  }
  return guess.toISOString();
}

/** Дата из объекта Date по ЛОКАЛЬНЫМ частям (для DatePicker: без сдвига в UTC). */
export function dateToIso(d: Date | null): string | undefined {
  if (!d) return undefined;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isoToDate(v?: string | null): Date | null {
  return v ? new Date(`${v}T00:00:00`) : null;
}

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** «2026-09» → «Сентябрь 2026» (в интерфейсе период читают, а не парсят). */
export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? period} ${y}`;
}

/** «480» минут → «8 ч», «450» → «7,5 ч» (округление до часа врало на полсмены). */
export function hoursLabel(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1).replace('.', ',')} ч`;
}

/** Цвет-данные шаблона + прозрачность: `${color}22` на нехекс-значении ломает CSS. */
export function tint(color: string | null | undefined, fallback = 'var(--surface-container)'): string {
  if (!color) return fallback;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}22` : fallback;
}
