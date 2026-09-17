/** Очередь и типы джобов движка вебхуков (core/jobs). */
export const WEBHOOKS_QUEUE = 'webhooks';

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

/** Redis-локи кронов движка. */
export const WEBHOOK_LOCKS = {
  daily: 'cron:webhooks:daily',
} as const;

/** Контекст AAD секретов endpoint'а (envelope под KEK организации). */
export const WEBHOOK_ENTITY = 'webhook_endpoint';
