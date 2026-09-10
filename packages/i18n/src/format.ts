import type { Locale } from '@superapp/shared';
import { REGION_PROFILE_KZ, regionProfileFor, type RegionProfile } from './config';

// ============================================================
// Форматтеры платформы: ИМЕНА от языка, ПРАВИЛА от региона.
//
// Разделение — несущее (модель Apple/Salesforce). Человек, выбравший English,
// в Казахстане по-прежнему видит `03.09.2026` и `12 500 ₸`, а не `9/3/2026` и
// `KZT 12,500.00`: язык переводит слова, а не переезжает в другую страну.
// Поэтому месяц/день недели берутся из `Intl` НА ЯЗЫКЕ, а разделители, порядок
// частей даты и валюта — из RegionProfile.
//
// Всё, что показывает время, обязано принимать `timeZone`: веб передаёт пояс
// УСТРОЙСТВА (модель Google), фон API — `User.timezone` адресата.
// ============================================================

export interface FormatContext {
  locale: Locale;
  /** IANA-зона. Не задана → зона рантайма (браузер) либо профиль региона (сервер). */
  timeZone?: string;
}

/** Точность времени: секунда нужна доказательствам, а не ленте */
export interface TimeOptions {
  seconds?: boolean;
}

export type DateStyle =
  /** 03.09.2026 — числовая дата в правилах региона */
  | 'short'
  /** 3 сентября 2026 — месяц прописью, порядок частей от языка */
  | 'long'
  /** 3 сентября — то же без года (ленты текущего года) */
  | 'dayMonthLong'
  /** четверг, 3 сентября */
  | 'weekday'
  /** сентябрь 2026 */
  | 'monthYear'
  /** 03.09 — компактно (рёбра схемы, короткие периоды) */
  | 'dayMonth';

const partsCache = new Map<string, Intl.DateTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();

function dtf(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = partsCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    partsCache.set(key, f);
  }
  return f;
}

function nf(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    numberCache.set(key, f);
  }
  return f;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Календарная дата `YYYY-MM-DD` (без времени) → Date в ПОЛДЕНЬ UTC. */
function dayKeyToDate(ymd: string): Date {
  // Полдень, а не полночь: полночь UTC при отрицательном смещении зоны
  // отображения превращается во вчерашний день — календарная дата (`@db.Date`)
  // пояса не имеет, и «03.09» обязано остаться «03.09» в любой зоне.
  return new Date(`${ymd.slice(0, 10)}T12:00:00Z`);
}

const DAY_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `formatToParts` + сборка по профилю региона.
 * Почему не готовая строка `toLocaleDateString`: она зависит от версии ICU в
 * рантайме (Node, Chrome, Safari и Hermes расходятся в разделителях и порядке),
 * и одна и та же дата выглядела бы по-разному на вебе и в мобильном.
 */
function datePartsOf(
  date: Date,
  ctx: FormatContext,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const profile = regionProfileFor(ctx.locale);
  const parts = dtf(ctx.locale, {
    ...options,
    ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
    ...(options.hour !== undefined ? { hour12: profile.hour12 } : {}),
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const p of parts) {
    // Повторяющиеся типы (в редких календарях) не перетираем: первый — главный.
    if (out[p.type] === undefined) out[p.type] = p.value;
  }
  return out;
}

/**
 * Календарная дата (`YYYY-MM-DD`) не имеет пояса: срок задачи «до 03.09» —
 * это 03.09 в Алматы и в Лондоне. Такие значения выводим В UTC, иначе зона
 * зрителя сдвинула бы день.
 */
function contextFor(value: Date | string | number, ctx: FormatContext): FormatContext {
  return typeof value === 'string' && value.length <= 10 && DAY_ONLY_RE.test(value)
    ? { locale: ctx.locale, timeZone: 'UTC' }
    : ctx;
}

function normalize(value: Date | string | number): Date {
  return typeof value === 'string' && value.length <= 10 && DAY_ONLY_RE.test(value)
    ? dayKeyToDate(value)
    : toDate(value);
}

/** `03.09.2026` — числовая дата в правилах региона (порядок и разделитель наши). */
export function formatDate(
  value: Date | string | number,
  ctx: FormatContext,
  style: DateStyle = 'short',
): string {
  const profile = regionProfileFor(ctx.locale);
  const date = normalize(value);
  if (Number.isNaN(date.getTime())) return '';
  const c = contextFor(value, ctx);

  if (style === 'short') {
    const p = datePartsOf(date, c, { day: '2-digit', month: '2-digit', year: 'numeric' });
    return [p.day, p.month, p.year].join(profile.dateSeparator);
  }
  if (style === 'dayMonth') {
    const p = datePartsOf(date, c, { day: '2-digit', month: '2-digit' });
    return [p.day, p.month].join(profile.dateSeparator);
  }
  if (style === 'monthYear') {
    const p = datePartsOf(date, c, { month: 'long', year: 'numeric' });
    return `${p.month} ${p.year}`;
  }
  if (style === 'dayMonthLong') {
    // Порядок «3 сентября» / «September 3» / «3 қыркүйек» принадлежит ЯЗЫКУ —
    // собирать его своим шаблоном значило бы переписывать грамматику каждого.
    return dtf(c.locale, {
      day: 'numeric',
      month: 'long',
      ...(c.timeZone ? { timeZone: c.timeZone } : {}),
    }).format(date);
  }
  if (style === 'weekday') {
    const p = datePartsOf(date, c, { weekday: 'long', day: 'numeric', month: 'long' });
    return `${p.weekday}, ${p.day} ${p.month}`;
  }
  // long: «3 сентября 2026» / «3 September 2026» / «2026 ж. 3 қыркүйек» —
  // порядок частей здесь принадлежит ЯЗЫКУ, поэтому строку собирает Intl.
  return dtf(c.locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(c.timeZone ? { timeZone: c.timeZone } : {}),
  }).format(date);
}

/** `14:35` — 24 часа всегда (в РК 12-часовые сутки не используются). */
/**
 * `14:35`, а с `{ seconds: true }` — `14:35:07`. Секунда нужна там, где время
 * само по себе доказательство: протокол подписания, журнал доступа.
 */
export function formatTime(
  value: Date | string | number,
  ctx: FormatContext,
  opts: TimeOptions = {},
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const p = datePartsOf(date, ctx, {
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
  });
  return opts.seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

/** `03.09.2026, 14:35` (с `{ seconds: true }` — `03.09.2026, 14:35:07`) */
export function formatDateTime(
  value: Date | string | number,
  ctx: FormatContext,
  style: DateStyle = 'short',
  opts: TimeOptions = {},
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatDate(date, ctx, style)}, ${formatTime(date, ctx, opts)}`;
}

/** `14:35 – 15:20`; если дни разные — обе даты целиком. */
export function formatTimeRange(
  from: Date | string | number,
  to: Date | string | number,
  ctx: FormatContext,
): string {
  const a = toDate(from);
  const b = toDate(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
  const sameDay = formatDayKey(a, ctx) === formatDayKey(b, ctx);
  // Тире с пробелами (EN DASH) — типографский диапазон, не дефис.
  return sameDay
    ? `${formatTime(a, ctx)} – ${formatTime(b, ctx)}`
    : `${formatDateTime(a, ctx)} – ${formatDateTime(b, ctx)}`;
}

/**
 * Имя дня недели ОТДЕЛЬНО от даты: «чт» над колонкой сетки, «четверг» в шапке.
 * Слово принадлежит ЯЗЫКУ, а не региону, — поэтому берётся у Intl напрямую.
 */
export function formatWeekday(
  value: Date | string | number,
  ctx: FormatContext,
  style: 'short' | 'long' = 'short',
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return dtf(ctx.locale, {
    weekday: style,
    ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
  }).format(date);
}

/**
 * Семь имён дней недели, начиная с первого дня НЕДЕЛИ РЕГИОНА (в РК —
 * понедельник). Шапку сетки нельзя писать массивом в коде: `['Пн','Вт',…]` —
 * это один язык навсегда, а порядок дней принадлежит региону, не языку.
 */
export function weekdayNames(ctx: FormatContext, style: 'short' | 'long' = 'short'): string[] {
  const profile = regionProfileFor(ctx.locale);
  // 2024-01-01 — понедельник; сдвигаемся от него на первый день недели профиля.
  const monday = Date.UTC(2024, 0, 1);
  const shift = (profile.firstDayOfWeek + 6) % 7;
  return Array.from({ length: 7 }, (_, i) =>
    dtf(ctx.locale, { weekday: style, timeZone: 'UTC' }).format(
      new Date(monday + ((shift + i) % 7) * 86_400_000),
    ),
  );
}

/** Месяц прописью без числа и года — заголовок мини-месяца и года. */
export function formatMonth(value: Date | string | number, ctx: FormatContext): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return dtf(ctx.locale, {
    month: 'long',
    ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
  }).format(date);
}

/** Локальный `YYYY-MM-DD` в поясе контекста — ключ группировки лент по дню зрителя. */
export function formatDayKey(value: Date | string | number, ctx: FormatContext): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  // en-CA даёт ISO-порядок во всех рантаймах — это ТЕХНИЧЕСКИЙ КЛЮЧ, а не текст для
  // человека: он никогда не показывается и обязан быть одинаковым во всех языках
  // (страж знает этот тег машинным, см. scripts/eslint-rules/no-cyrillic-literal.cjs).
  return new Intl.DateTimeFormat('en-CA', ctx.timeZone ? { timeZone: ctx.timeZone } : {}).format(date);
}

export interface NumberOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/** `1 234,5` — разделители из профиля региона, цифры латинские. */
export function formatNumber(value: number, ctx: FormatContext, options: NumberOptions = {}): string {
  if (!Number.isFinite(value)) return '';
  const profile = regionProfileFor(ctx.locale);
  const parts = nf(profile.numericLocale, {
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits:
      options.maximumFractionDigits ?? Math.max(options.minimumFractionDigits ?? 0, 3),
    useGrouping: true,
  }).formatToParts(value);
  return parts
    .map((p) => {
      if (p.type === 'group') return profile.groupSeparator;
      if (p.type === 'decimal') return profile.decimalSeparator;
      return p.value;
    })
    .join('');
}

/**
 * Сумма из МИНИМАЛЬНЫХ единиц (как хранит леджер: 0 знаков у коинов, 2 у фиата).
 * `symbol` — знак валюты; для внутренних валют организации его даёт сама валюта,
 * `null` печатает голое число.
 */
export function formatMoney(
  minor: number,
  ctx: FormatContext,
  opts: { scale?: number; symbol?: string | null } = {},
): string {
  const profile = regionProfileFor(ctx.locale);
  const scale = opts.scale ?? 2;
  const value = scale > 0 ? minor / 10 ** scale : minor;
  const num = formatNumber(value, ctx, { minimumFractionDigits: scale, maximumFractionDigits: scale });
  const symbol = opts.symbol === undefined ? profile.currencySymbol : opts.symbol;
  // Знак ПОСЛЕ суммы с неразрывным пробелом — правило рынка РК, не языка.
  return symbol ? `${num} ${symbol}` : num;
}

/** Единицы размера файла — слова приходят из каталога `common.units`. */
export interface ByteUnits {
  b: string;
  kb: string;
  mb: string;
  gb: string;
}

/** 1 КБ = 1024 Б (как показывают ОС). */
export function formatBytes(bytes: number, ctx: FormatContext, units: ByteUnits): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${formatNumber(bytes, ctx, { maximumFractionDigits: 0 })} ${units.b}`;
  if (abs < 1024 ** 2) return `${formatNumber(bytes / 1024, ctx, { maximumFractionDigits: 0 })} ${units.kb}`;
  if (abs < 1024 ** 3) return `${formatNumber(bytes / 1024 ** 2, ctx, { maximumFractionDigits: 1 })} ${units.mb}`;
  return `${formatNumber(bytes / 1024 ** 3, ctx, { maximumFractionDigits: 2 })} ${units.gb}`;
}

// ============================================================
// ПОРЯДОК СЛОВ — тоже язык.
//
// `a.localeCompare(b)` без языка берёт умолчание РАНТАЙМА: у сервера это
// окружение процесса, у браузера — настройка системы, и один и тот же список
// людей приходит на экран в разном порядке. Для казахского это не мелочь:
// Ә, Ғ, Қ, Ң, Ө, Ұ, Ү, Һ, І стоят в алфавите СВОИМИ местами, а не рядом с
// «похожими» русскими буквами, — сортировка чужим языком рассыпает ростер.
//
// Коллятор дорогой, поэтому кэшируется на язык: список людей зовёт сравнение
// N·log N раз.
// ============================================================
const collators = new Map<string, Intl.Collator>();

/** Сравнение имён (людей, отделов, файлов) в алфавите ЗРИТЕЛЯ. */
export function compareNames(locale: Locale): (a: string, b: string) => number {
  let hit = collators.get(locale);
  if (!hit) {
    // `numeric` — чтобы «Объект 2» шёл перед «Объект 10»; `base` не различает
    // регистр и диакритику: человек ищет имя, а не байты.
    hit = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collators.set(locale, hit);
  }
  return hit.compare;
}

/** Набор форматтеров, привязанный к языку и поясу — удобно передавать одним объектом. */
export interface Formatters {
  locale: Locale;
  timeZone?: string;
  region: RegionProfile;
  date(value: Date | string | number, style?: DateStyle): string;
  time(value: Date | string | number, opts?: TimeOptions): string;
  dateTime(value: Date | string | number, style?: DateStyle, opts?: TimeOptions): string;
  timeRange(from: Date | string | number, to: Date | string | number): string;
  dayKey(value: Date | string | number): string;
  /** Имя дня недели без даты («чт» / «четверг») */
  weekday(value: Date | string | number, style?: 'short' | 'long'): string;
  /** Семь имён дней недели с первого дня недели региона */
  weekdayNames(style?: 'short' | 'long'): string[];
  /** Месяц прописью без числа и года */
  month(value: Date | string | number): string;
  number(value: number, options?: NumberOptions): string;
  money(minor: number, opts?: { scale?: number; symbol?: string | null }): string;
  /** Сравнение имён в алфавите зрителя — для `sort` любых человекочитаемых списков */
  compare(a: string, b: string): number;
}

export function createFormatters(locale: Locale, timeZone?: string): Formatters {
  const ctx: FormatContext = { locale, timeZone };
  return {
    locale,
    timeZone,
    region: regionProfileFor(locale),
    date: (v, style) => formatDate(v, ctx, style),
    time: (v, o) => formatTime(v, ctx, o),
    dateTime: (v, style, o) => formatDateTime(v, ctx, style, o),
    timeRange: (a, b) => formatTimeRange(a, b, ctx),
    dayKey: (v) => formatDayKey(v, ctx),
    weekday: (v, style) => formatWeekday(v, ctx, style),
    weekdayNames: (style) => weekdayNames(ctx, style),
    month: (v) => formatMonth(v, ctx),
    number: (v, o) => formatNumber(v, ctx, o),
    money: (v, o) => formatMoney(v, ctx, o),
    compare: compareNames(locale),
  };
}

export { REGION_PROFILE_KZ };
export type { RegionProfile };
