import { IDEMPOTENCY_LIMITS, IDEMPOTENCY_MODES, type IdempotencyMode } from '@superapp/shared';

// ============================================================
// core/idempotency — константы движка (режимы, сроки, имена)
// ============================================================

/** Имя HMAC-ключа платформы для отпечатка формы запроса (`MAC_KEY_NAMES`). */
export const IDEMPOTENCY_MAC_NAME = 'idempotency' as const;

/** Скоуп-шифра снимка тела: своя сущность/поле в AAD (`KeysEnvelopeService`). */
export const IDEMPOTENCY_RESPONSE_ENTITY = 'idem_response';
export const IDEMPOTENCY_RESPONSE_FIELD = 'body';

/** Вид принципала в строке ключа (`idem.keys.principal`). */
export const IDEMPOTENCY_PRINCIPALS = ['user', 'api_key', 'bot', 'guest', 'webhook'] as const;
export type IdempotencyPrincipalKind = (typeof IDEMPOTENCY_PRINCIPALS)[number];

/** Исходы одного обращения — метка метрики `idem_requests_total`. */
export const IDEMPOTENCY_RESULTS = [
  'new',
  'replay',
  'in_flight',
  'mismatch',
  'takeover',
  'unknown',
  'fenced',
  'released',
] as const;
export type IdempotencyResult = (typeof IDEMPOTENCY_RESULTS)[number];

const int = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/**
 * Настройки движка из env. Читаются на вызове (после `validateEnv` в main.ts), а не
 * константами модуля — те вычислялись бы до разбора окружения.
 *
 * Режим по умолчанию — `enforce`: движок защищает с первого запуска. `observe` —
 * окно выката (заявки заводятся, но отказов нет), `off` — полный стоп-кран.
 */
export function idempotencyEnv(): {
  mode: IdempotencyMode;
  keyTtlDays: number;
  responseTtlHours: number;
  leaseMs: number;
  maxResponseBytes: number;
  build: string | null;
} {
  const raw = process.env.IDEMPOTENCY_MODE;
  const mode = (IDEMPOTENCY_MODES as readonly string[]).includes(raw ?? '') ? (raw as IdempotencyMode) : 'enforce';
  return {
    mode,
    keyTtlDays: int(process.env.IDEMPOTENCY_KEY_TTL_DAYS, IDEMPOTENCY_LIMITS.keyTtlDays),
    responseTtlHours: int(process.env.IDEMPOTENCY_RESPONSE_TTL_HOURS, IDEMPOTENCY_LIMITS.responseTtlHours),
    leaseMs: int(process.env.IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_LIMITS.leaseMs),
    maxResponseBytes: int(process.env.IDEMPOTENCY_MAX_RESPONSE_BYTES, IDEMPOTENCY_LIMITS.maxResponseBytes),
    build: process.env.APP_BUILD?.slice(0, 64) || null,
  };
}
