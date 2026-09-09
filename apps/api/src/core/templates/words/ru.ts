import type { NumberWords } from './types';

// ============================================================
// ЧИСЛИТЕЛЬНЫЕ РУССКОГО ЯЗЫКА — словарь бланка, а не подписи экрана.
//
// «Прописью» в приказе — это грамматика: род единиц внутри триады, три формы
// разряда, тире и падежи. Такой словарь нельзя разложить по ключам каталога
// (ключ отдаёт ФРАЗУ, а здесь работает алгоритм), поэтому он живёт отдельным
// файлом на язык и стоит постоянным исключением стража кириллицы.
// ============================================================

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

/** Форма слова разряда по числу триады (11–14 — особый случай) */
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

export const wordsRu: NumberWords = {
  maxScale: SCALES.length,
  zero: 'ноль',
  minus: 'минус',
  toWords(triads: number[]): string {
    const words: string[] = [];
    for (let i = triads.length - 1; i >= 0; i--) {
      const t = triads[i];
      if (t === 0) continue;
      const scale = SCALES[i];
      words.push(...triadWords(t, scale.feminine));
      if (i > 0) words.push(pluralRu(t, scale.forms));
    }
    return words.join(' ');
  },
  money(amountWords: string, frac2: string): string {
    return `${amountWords} тенге ${frac2} тиын`;
  },
};
