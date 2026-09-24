/** Очередь и типы джобов движка вебхуков (core/jobs). */
export const WEBHOOKS_QUEUE = 'webhooks';

/**
 * Слотов очереди на инстанс. Cap — свойство ОЧЕРЕДИ (min по её типам), поэтому ОБА типа
 * объявляют одно число: узкий тип сузил бы доставку. Аудит от доставок отделяет приоритет.
 */
export const WEBHOOKS_QUEUE_CONCURRENCY = 8;

/** Приоритет постановки аудита (0 — высший): ночная волна проб не обгоняет доставку событий. */
export const WEBHOOK_PROBE_PRIORITY = 5;

export const WEBHOOK_JOBS = {
  /** Доставка одной строки WebhookDelivery (идемпотентно, ретраи с бэкоффом) */
  deliver: 'webhooks.deliver',
  /** Аудит битой подписью (модель Discord): 2xx на невалидную подпись → endpoint disabled */
  probe: 'webhooks.probe',
} as const;

/** Действия журнала ключей для endpoint'ов (subjectType `webhook_endpoint`). */
export const WEBHOOK_AUDIT = {
  created: 'webhook.endpoint.created',
  updated: 'webhook.endpoint.updated',
  enabled: 'webhook.endpoint.enabled',
  disabled: 'webhook.endpoint.disabled',
  deleted: 'webhook.endpoint.deleted',
  secretRotated: 'webhook.endpoint.secret_rotated',
  verified: 'webhook.endpoint.verified',
} as const;

/**
 * Тело доставки старше `WEBHOOK_LIMITS.bodyRetentionDays` заменено отпечатком:
 * `{ redacted: true, id, type, sha256 }` (id и тип сообщения — для журнала доставок).
 */
export function isRedactedBody(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as { redacted?: unknown }).redacted === true;
}

/** Redis-локи кронов движка. */
export const WEBHOOK_LOCKS = {
  daily: 'cron:webhooks:daily',
} as const;

/** Контекст AAD секретов endpoint'а (envelope под KEK организации). */
export const WEBHOOK_ENTITY = 'webhook_endpoint';
