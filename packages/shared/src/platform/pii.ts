import { normalizePhone } from '../utils/phone';

// ============================================================
// PII в кабинете платформы — скрыт по умолчанию, раскрытие командой с причиной
// ============================================================
// Маска — ТО, что видит сотрудник до `platform.pii.reveal`. Формат подобран так,
// чтобы человека можно было ОПОЗНАТЬ (последние цифры), но не выгрузить базу
// поштучно через карточки (S10/S11).

/** `+77001234567` → `+7 700 ••• 45 67` (последние четыре цифры видны). */
export function maskPhoneForConsole(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const n = normalizePhone(phone);
  const digits = n.replace(/\D/g, '');
  if (digits.length < 7) return '•••';
  const last4 = digits.slice(-4);
  const head = digits.length === 11 ? `+${digits[0]} ${digits.slice(1, 4)}` : `+${digits.slice(0, -8)}`;
  return `${head} ••• ${last4.slice(0, 2)} ${last4.slice(2)}`;
}

/** ИИН/БИН (12 цифр) → `••••••••1234`; иные строки — по тому же правилу последних четырёх. */
export function maskIdNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).trim();
  if (s.length <= 4) return '•'.repeat(s.length);
  return `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
}

/** Имена полей входа команд, которые аудит маскирует автоматически (S7). */
export const PLATFORM_REDACT_FIELD_PATTERN = /(password|token|secret|otp|code|pan|iban|cvv|cvc)/i;

/** Заглушка замаскированного значения в журнале аудита. */
export const PLATFORM_REDACTED = '[redacted]';

/**
 * Маскирование объекта входа для журнала: по списку из декларации команды и по
 * имени поля на ЛЮБОЙ глубине. Возвращает новый объект; исходный не трогается.
 */
export function redactForAudit(input: unknown, extraFields: readonly string[] = []): unknown {
  const extra = new Set(extraFields);
  const walk = (v: unknown, keyName: string | null): unknown => {
    if (keyName && (extra.has(keyName) || PLATFORM_REDACT_FIELD_PATTERN.test(keyName))) return PLATFORM_REDACTED;
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return walk(input, null);
}
