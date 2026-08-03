// ============================================================
// Контрольные проверки реквизитов (Казахстан).
//
// Чистые функции без зависимостей: ими пользуются и Zod-схемы (shared), и веб
// (подсказка «номер с опечаткой» до отправки формы). Все алгоритмы — публичные
// стандарты, ничего самодельного:
//   ИИН/БИН — ГОСТ РК: два прохода весов по модулю 11;
//   IBAN    — ISO 13616: перестановка + mod 97 == 1;
//   Карта   — алгоритм Луна.
// ============================================================

/** 12 цифр + контрольная сумма (последняя цифра). Общий алгоритм ИИН и БИН. */
export function isValidIinOrBin(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  const d = value.split('').map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  let s = d.slice(0, 11).reduce((acc, x, i) => acc + x * w1[i], 0) % 11;
  if (s === 10) {
    s = d.slice(0, 11).reduce((acc, x, i) => acc + x * w2[i], 0) % 11;
    if (s === 10) return false; // такой номер не выдаётся вовсе
  }
  return s === d[11];
}

/** Нормализация IBAN: без пробелов, верхний регистр */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * Казахстанский IBAN: `KZ` + 2 контрольные цифры + 16 знаков (всего 20),
 * контроль — ISO 13616 (первые четыре знака в конец, буквы → числа, mod 97 == 1).
 */
export function isValidKzIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^KZ\d{2}[A-Z0-9]{16}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  // Число длиннее 2^53 — считаем модуль по кускам (классический приём без BigInt).
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) {
    rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  }
  return rem === 1;
}

/** БИК банка РК — 8 знаков SWIFT-формата (например CASPKZKA) */
export function isValidBik(value: string): boolean {
  return /^[A-Z]{4}[A-Z0-9]{2}[A-Z0-9]{2}$/.test(value.toUpperCase());
}

/** КБе — две цифры (код бенефициара в платёжке) */
export function isValidKbe(value: string): boolean {
  return /^\d{2}$/.test(value);
}

/** Номер карты: только цифры, без пробелов */
export function normalizeCardPan(value: string): string {
  return value.replace(/[\s-]+/g, '');
}

/** Алгоритм Луна: 13–19 цифр (все живые схемы карт) */
export function isValidCardPan(value: string): boolean {
  const pan = normalizeCardPan(value);
  if (!/^\d{13,19}$/.test(pan)) return false;
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let x = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return sum % 10 === 0;
}

/** «•••• 1234» — маска карты для списков */
export function maskCardPan(last4: string): string {
  return `•••• ${last4}`;
}

/** Срок карты не в прошлом (месяц включительно) */
export function isCardExpiryAlive(expMonth: number, expYear: number, now = new Date()): boolean {
  const y = expYear < 100 ? 2000 + expYear : expYear;
  return y > now.getFullYear() || (y === now.getFullYear() && expMonth >= now.getMonth() + 1);
}
