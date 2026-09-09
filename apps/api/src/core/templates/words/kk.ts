import type { NumberWords } from './types';

// ============================================================
// ЧИСЛИТЕЛЬНЫЕ КАЗАХСКОГО ЯЗЫКА — словарь бланка (см. `ru.ts` о том, почему
// это файл, а не каталог).
//
// Казахская пропись проще русской: рода нет, форма разряда одна («мың» и в
// «бір мың», и в «тоғыз мың»), слова идут строго от старшего разряда к
// младшему. Единица перед разрядом ставится явно («бір мың»), а «жүз» без
// единицы — так пишут в документах.
//
// ВЫЧИТКА НОСИТЕЛЕМ — отдельный трек вместе со всем kk-каталогом
// (docs/i18n_migration.md).
// ============================================================

const UNITS = ['', 'бір', 'екі', 'үш', 'төрт', 'бес', 'алты', 'жеті', 'сегіз', 'тоғыз'];
const TENS = ['', 'он', 'жиырма', 'отыз', 'қырық', 'елу', 'алпыс', 'жетпіс', 'сексен', 'тоқсан'];
const SCALES = ['', 'мың', 'миллион', 'миллиард', 'триллион'];

function triadWords(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  if (hundreds > 0) {
    // «жүз», «екі жүз», «тоғыз жүз» — единица перед сотней не пишется
    if (hundreds > 1) words.push(UNITS[hundreds]);
    words.push('жүз');
  }
  const tens = Math.floor((n % 100) / 10);
  if (tens > 0) words.push(TENS[tens]);
  const unit = n % 10;
  if (unit > 0) words.push(UNITS[unit]);
  return words;
}

export const wordsKk: NumberWords = {
  maxScale: SCALES.length,
  zero: 'нөл',
  minus: 'минус',
  toWords(triads: number[]): string {
    const words: string[] = [];
    for (let i = triads.length - 1; i >= 0; i--) {
      const t = triads[i];
      if (t === 0) continue;
      words.push(...triadWords(t));
      if (i > 0) words.push(SCALES[i]);
    }
    return words.join(' ');
  },
  money(amountWords: string, frac2: string): string {
    return `${amountWords} теңге ${frac2} тиын`;
  },
};
