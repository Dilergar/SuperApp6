import { normalizePhone } from '../utils/phone';
import { PLATFORM_LIMITS } from './commands';

// ============================================================
// Парсер строки поиска кабинета — ОДНА реализация на сервер и веб
// ============================================================
// Веб показывает чип-подсказку («похоже на телефон»), сервер решает, по каким
// провайдерам искать. Правила S10: телефон — только ПОЛНЫЙ E.164, ИИН/БИН —
// ровно 12 цифр, uuid — целиком, текст — от `searchMinChars` символов.

export type PlatformQueryKind = 'phone' | 'idNumber' | 'uuid' | 'text' | 'empty' | 'tooShort';

export interface ParsedPlatformQuery {
  kind: PlatformQueryKind;
  /** Нормализованное значение (телефон в E.164, цифры, uuid в нижнем регистре, обрезанный текст) */
  value: string;
  raw: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePlatformQuery(raw: string): ParsedPlatformQuery {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { kind: 'empty', value: '', raw };
  if (UUID_RE.test(trimmed)) return { kind: 'uuid', value: trimmed.toLowerCase(), raw };
  const digitsOnly = trimmed.replace(/[\s\-()]/g, '');
  if (/^\d{12}$/.test(digitsOnly)) return { kind: 'idNumber', value: digitsOnly, raw };
  if (/^[+\d][\d\s\-()]{6,}$/.test(trimmed)) {
    const phone = normalizePhone(trimmed);
    // Полный номер: `+` и 11–15 цифр (E.164). Неполный — не телефон и не текст: пусто.
    if (/^\+\d{11,15}$/.test(phone)) return { kind: 'phone', value: phone, raw };
    return { kind: 'tooShort', value: phone, raw };
  }
  if (trimmed.length < PLATFORM_LIMITS.searchMinChars) return { kind: 'tooShort', value: trimmed, raw };
  return { kind: 'text', value: trimmed.slice(0, 120), raw };
}
