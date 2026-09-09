import { APP_TIMEZONE, TEMPLATE_FORMATTER_ARGS } from '@superapp/shared';
import { createFormatters, regionProfileFor, type Locale } from '@superapp/i18n';
import { numberWordsFor } from './words';
import type { TemplatePrint } from './template.types';

/**
 * Форматтеры значений шаблона — цепочкой после `|` в теге (идея Carbone,
 * реализация своя).
 *
 * ЯЗЫК ЗДЕСЬ — ЯЗЫК БЛАНКА, а не зрителя: один и тот же приказ печатается на
 * том языке, на котором составлен, кто бы его ни открыл. Слова («прописью»,
 * «Да»/«Нет») берутся у языка, ПРАВИЛА (разделитель разрядов, порядок частей
 * даты) — у региона: человек, выбравший English, в Казахстане по-прежнему
 * читает `01.09.2026`, а не `9/1/2026`.
 *
 * Часовой пояс — APP_TIMEZONE: «2026-09-01» НИКОГДА не уезжает на 31.08 (мина,
 * пойманная у Carbone при проверке кандидатов).
 */

/** Ошибка формата значения — драйвер оборачивает её в понятное «тег такой-то» */
export class TemplateFormatError extends Error {
  /**
   * Ключ каталога БЕЗ префикса `errors.` + параметры: язык замечанию подбирают
   * на выходе (`templateIssueText`), потому что форматтер работает и в джобе.
   * `message` — машинный, для лога.
   */
  constructor(
    readonly messageKey: string,
    readonly params: Record<string, string | number>,
  ) {
    super(`${messageKey} ${JSON.stringify(params)}`);
    this.name = 'TemplateFormatError';
  }
}

/** Число → триады от младшей к старшей (сотни-десятки-единицы, тысячи, …) */
function toTriads(value: bigint): number[] {
  const triads: number[] = [];
  let n = value;
  while (n > 0n) {
    triads.push(Number(n % 1000n));
    n /= 1000n;
  }
  return triads;
}

/** Целое число словами языка бланка (0 → «ноль»/«zero»/«нөл») */
export function numberToWords(value: number | bigint, locale: Locale, tagHint: string): string {
  const words = numberWordsFor(locale);
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const negative = n < 0n;
  if (negative) n = -n;
  if (n === 0n) return words.zero;
  const triads = toTriads(n);
  if (triads.length > words.maxScale) {
    throw new TemplateFormatError('templates.valueTooBigForWords', { tag: tagHint });
  }
  return (negative ? `${words.minus} ` : '') + words.toWords(triads);
}

function parseAmount(value: unknown, tagHint: string): { int: bigint; frac2: string } {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TemplateFormatError('templates.valueNotANumber', { tag: tagHint });
    s = value.toFixed(2);
  } else if (typeof value === 'string') {
    s = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  } else {
    throw new TemplateFormatError('templates.valueNotAnAmount', { tag: tagHint });
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new TemplateFormatError('templates.valueNotANumberValue', { tag: tagHint, value: String(value) });
  }
  const [intPart, fracRaw = ''] = s.split('.');
  const frac2 = (fracRaw + '00').slice(0, 2);
  return { int: BigInt(intPart), frac2 };
}

/** «12 345,67» → «Двенадцать тысяч триста сорок пять тенге 67 тиын» (валюта РК) */
export function moneyToWords(value: unknown, locale: Locale, tagHint: string): string {
  const { int, frac2 } = parseAmount(value, tagHint);
  const words = numberWordsFor(locale);
  const amount = numberToWords(int < 0n ? -int : int, locale, tagHint);
  const sign = int < 0n ? `${words.minus} ` : '';
  const text = words.money(`${sign}${amount}`, frac2);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Число с разрядами: 1234567.89 → «1 234 567,89». Разделители — ПРАВИЛА РЕГИОНА
 * (профиль КЗ), а не языка; группировка своя, а не через Intl, потому что
 * значение может быть длиннее, чем выдерживает число JS (номер, счёт, объём).
 */
export function formatTemplateNumber(value: unknown, locale: Locale, tagHint: string): string {
  const region = regionProfileFor(locale);
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TemplateFormatError('templates.valueNotANumber', { tag: tagHint });
    s = String(value);
  } else if (typeof value === 'string') {
    s = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  } else {
    throw new TemplateFormatError('templates.valueNotANumber', { tag: tagHint });
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new TemplateFormatError('templates.valueNotANumberValue', { tag: tagHint, value: String(value) });
  }
  const negative = s.startsWith('-');
  const [intPart, frac = ''] = (negative ? s.slice(1) : s).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, region.groupSeparator);
  return (negative ? '-' : '') + grouped + (frac ? region.decimalSeparator + frac : '');
}

/**
 * Значение даты к виду, который понимает форматтер платформы. Строка
 * «2026-09-01…» остаётся КАЛЕНДАРНОЙ (без часовых поясов): ровно здесь Carbone
 * терял день при рендере в поясе восточнее UTC.
 */
function normalizeDate(value: unknown, tagHint: string): string | Date {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const day = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (day) return day[1];
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    throw new TemplateFormatError('templates.valueNotADateValue', { tag: tagHint, value: trimmed });
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new TemplateFormatError('templates.valueNotADate', { tag: tagHint });
}

/** Дата в языке бланка и правилах региона: «01.09.2026» / «1 сентября 2026 г.» */
export function formatTemplateDate(value: unknown, long: boolean, locale: Locale, tagHint: string): string {
  const normalized = normalizeDate(value, tagHint);
  return createFormatters(locale, APP_TIMEZONE).date(normalized, long ? 'long' : 'short');
}

/** Значение без форматтера: даты — короткой датой, булевы — словами бланка */
export function defaultToString(value: unknown, print: TemplatePrint, tagHint: string): string {
  if (value instanceof Date) return formatTemplateDate(value, false, print.language, tagHint);
  if (typeof value === 'boolean') return print.t(value ? 'templates.print.yes' : 'templates.print.no');
  return String(value);
}

export function isKnownFormatter(key: string, arg?: string): boolean {
  const args = TEMPLATE_FORMATTER_ARGS[key];
  if (!args) return false;
  return arg === undefined || args.includes(arg);
}

/**
 * Применить цепочку форматтеров тега к значению в языке БЛАНКА.
 */
export function applyFormatterChain(
  value: unknown,
  chain: { key: string; arg?: string }[],
  tagHint: string,
  print: TemplatePrint,
): string {
  if (!chain.length) return defaultToString(value, print, tagHint);
  let current: unknown = value;
  for (const f of chain) {
    switch (f.key) {
      case 'date':
        current = formatTemplateDate(current, f.arg === 'long', print.language, tagHint);
        break;
      case 'words':
        if (f.arg === 'number') {
          const { int } = parseAmount(current, tagHint);
          current = numberToWords(int, print.language, tagHint);
        } else {
          current = moneyToWords(current, print.language, tagHint);
        }
        break;
      case 'number':
        current = formatTemplateNumber(current, print.language, tagHint);
        break;
      default:
        // Компилятор отсеивает неизвестные форматтеры раньше; сюда — только при рассинхроне
        throw new TemplateFormatError('templates.unknownFormatter', { formatter: f.key, tag: tagHint });
    }
  }
  return String(current);
}
