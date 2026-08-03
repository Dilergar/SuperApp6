import { APP_TIMEZONE, MONTH_NAMES_RU, TEMPLATE_FORMATTER_ARGS } from '@superapp/shared';

/**
 * Форматтеры значений шаблона — цепочкой после `|` в теге (идея Carbone,
 * реализация своя). Локаль и часовой пояс зашиты здесь: русские месяцы,
 * APP_TIMEZONE для дат-моментов — «2026-09-01» НИКОГДА не уезжает на 31.08
 * (мина, пойманная у Carbone при проверке кандидатов).
 */

/** Ошибка формата значения — драйвер оборачивает её в понятное «тег такой-то» */
export class TemplateFormatError extends Error {}

const UNITS_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const UNITS_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Разряды триад: [ед.ч., 2–4, 5+], род единиц внутри триады */
const SCALES: { forms: [string, string, string]; feminine: boolean }[] = [
  { forms: ['', '', ''], feminine: false }, // сотни-десятки-единицы
  { forms: ['тысяча', 'тысячи', 'тысяч'], feminine: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], feminine: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], feminine: false },
  { forms: ['триллион', 'триллиона', 'триллионов'], feminine: false },
];

export function pluralRu(n: number, forms: [string, string, string]): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = n % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function triadWords(n: number, feminine: boolean): string[] {
  const words: string[] = [];
  if (HUNDREDS[Math.floor(n / 100)]) words.push(HUNDREDS[Math.floor(n / 100)]);
  const rest = n % 100;
  if (rest >= 10 && rest <= 19) {
    words.push(TEENS[rest - 10]);
  } else {
    if (TENS[Math.floor(rest / 10)]) words.push(TENS[Math.floor(rest / 10)]);
    const unit = rest % 10;
    const unitWord = (feminine ? UNITS_F : UNITS_M)[unit];
    if (unitWord) words.push(unitWord);
  }
  return words;
}

/** Целое число словами (0 → «ноль»); поддержка до триллионов */
export function numberToWordsRu(value: number | bigint): string {
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const negative = n < 0n;
  if (negative) n = -n;
  if (n === 0n) return 'ноль';
  if (n >= 1_000_000_000_000_000n) throw new TemplateFormatError('число слишком велико для прописи');

  const triads: number[] = [];
  while (n > 0n) {
    triads.push(Number(n % 1000n));
    n /= 1000n;
  }
  const words: string[] = [];
  for (let i = triads.length - 1; i >= 0; i--) {
    const t = triads[i];
    if (t === 0) continue;
    const scale = SCALES[i];
    words.push(...triadWords(t, scale.feminine));
    if (i > 0) words.push(pluralRu(t, scale.forms));
  }
  return (negative ? 'минус ' : '') + words.join(' ');
}

function parseAmount(value: unknown, tagHint: string): { int: bigint; frac2: string } {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TemplateFormatError(`«${tagHint}»: не число`);
    s = value.toFixed(2);
  } else if (typeof value === 'string') {
    s = value.trim().replace(/\s| /g, '').replace(',', '.');
  } else {
    throw new TemplateFormatError(`«${tagHint}»: ожидалась сумма (число)`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new TemplateFormatError(`«${tagHint}»: не число — ${String(value)}`);
  const [intPart, fracRaw = ''] = s.split('.');
  const frac2 = (fracRaw + '00').slice(0, 2);
  return { int: BigInt(intPart), frac2 };
}

/** «12 345,67» → «Двенадцать тысяч триста сорок пять тенге 67 тиын» */
export function moneyToWordsKzt(value: unknown, tagHint: string): string {
  const { int, frac2 } = parseAmount(value, tagHint);
  const words = numberToWordsRu(int < 0n ? -int : int);
  const sign = int < 0n ? 'минус ' : '';
  const text = `${sign}${words} тенге ${frac2} тиын`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Число с разрядами: 1234567.89 → «1 234 567,89» (пробел — разряды, запятая — дробь) */
export function formatNumberRu(value: unknown, tagHint: string): string {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TemplateFormatError(`«${tagHint}»: не число`);
    s = String(value);
  } else if (typeof value === 'string') {
    s = value.trim().replace(/\s| /g, '').replace(',', '.');
  } else {
    throw new TemplateFormatError(`«${tagHint}»: ожидалось число`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new TemplateFormatError(`«${tagHint}»: не число — ${String(value)}`);
  const negative = s.startsWith('-');
  const [intPart, frac = ''] = (negative ? s.slice(1) : s).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (negative ? '-' : '') + grouped + (frac ? ',' + frac : '');
}

function dateParts(value: unknown, tagHint: string): { y: number; m: number; d: number } {
  // Строка «2026-09-01…» — берём КАЛЕНДАРНЫЕ части как есть, без часовых поясов:
  // ровно здесь Carbone терял день (31.08 при рендере 2026-09-01 в поясе восточнее UTC).
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return momentParts(parsed);
    throw new TemplateFormatError(`«${tagHint}»: не дата — ${value}`);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return momentParts(value);
  throw new TemplateFormatError(`«${tagHint}»: не дата`);
}

/** Момент времени → календарные части в APP_TIMEZONE (сервер может стоять в UTC) */
function momentParts(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: get('year'), m: get('month'), d: get('day') };
}

export function formatDateRu(value: unknown, long: boolean, tagHint: string): string {
  const { y, m, d } = dateParts(value, tagHint);
  if (long) return `${d} ${MONTH_NAMES_RU[m - 1]} ${y} г.`;
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

/** Значение без форматтера: даты — короткой датой, булевы — словами, остальное строкой */
export function defaultToString(value: unknown, tagHint: string): string {
  if (value instanceof Date) return formatDateRu(value, false, tagHint);
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

export function isKnownFormatter(key: string, arg?: string): boolean {
  const args = TEMPLATE_FORMATTER_ARGS[key];
  if (!args) return false;
  return arg === undefined || args.includes(arg);
}

/** Применить цепочку форматтеров тега к значению */
export function applyFormatterChain(
  value: unknown,
  chain: { key: string; arg?: string }[],
  tagHint: string,
): string {
  if (!chain.length) return defaultToString(value, tagHint);
  let current: unknown = value;
  for (const f of chain) {
    switch (f.key) {
      case 'дата':
        current = formatDateRu(current, f.arg === 'долгая', tagHint);
        break;
      case 'прописью':
        if (f.arg === 'число') {
          const { int } = parseAmount(current, tagHint);
          current = numberToWordsRu(int);
        } else {
          current = moneyToWordsKzt(current, tagHint);
        }
        break;
      case 'число':
        current = formatNumberRu(current, tagHint);
        break;
      default:
        // Компилятор отсеивает неизвестные форматтеры раньше; сюда — только при рассинхроне
        throw new TemplateFormatError(`«${tagHint}»: неизвестный форматтер «${f.key}»`);
    }
  }
  return String(current);
}
