import type { NumberWords } from './types';

// ============================================================
// Числительные английского языка — словарь бланка (см. `ru.ts`).
//
// Двузначные пишутся через дефис («forty-five»), сотня всегда с единицей
// («one hundred»), «and» между сотнями и десятками не ставится — американская
// норма, принятая в международных договорах.
// ============================================================

const UNITS = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function triadWords(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  if (hundreds > 0) words.push(UNITS[hundreds], 'hundred');
  const rest = n % 100;
  if (rest >= 20) {
    const unit = rest % 10;
    words.push(unit ? `${TENS[Math.floor(rest / 10)]}-${UNITS[unit]}` : TENS[Math.floor(rest / 10)]);
  } else if (rest > 0) {
    words.push(UNITS[rest]);
  }
  return words;
}

export const wordsEn: NumberWords = {
  maxScale: SCALES.length,
  zero: 'zero',
  minus: 'minus',
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
    return `${amountWords} tenge ${frac2} tiyn`;
  },
};
