import { maskIdLast4, maskPhone } from '../visibility/masks';

// ============================================================
// PII в кабинете платформы — скрыт по умолчанию, раскрытие командой с причиной
// ============================================================
// Маска — ТО, что видит сотрудник до `platform.pii.reveal`. Формат подобран так,
// чтобы человека можно было ОПОЗНАТЬ (последние цифры), но не выгрузить базу
// поштучно через карточки (S10/S11).

/**
 * Маски Кабинета = маски продукта (R23): одна функция на вид данных на ВСЕХ поверхностях,
 * иначе маска Кабинета и маска карточки складывались бы в оригинал. Имена оставлены для
 * потребителей Кабинета (`EntityCard` и панели 360).
 */
export const maskPhoneForConsole = maskPhone;
/** ИИН/БИН/номер документа → последние четыре (`id_last4`). */
export const maskIdNumber = maskIdLast4;

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
