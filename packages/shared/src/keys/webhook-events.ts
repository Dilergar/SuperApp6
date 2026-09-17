// ============================================================
// core/webhooks — реестр событий наружу (сливается из файлов сервисов)
// ============================================================
// Продюсер объявляет событие здесь и зовёт `WebhooksService.emit(tx, …)` в
// транзакции мутации. Ключ = `<service>.<object>.<action>`; сервис-владелец —
// первый сегмент. Слова (`keys.webhookEvents.<key>`) — в каталоге.

export interface WebhookEventDef {
  /** Сервис-владелец — первый сегмент ключа */
  service: string;
  /** Версия формы payload (получатель видит её в теле) */
  version: number;
}

export function defineWebhookEvents<const T extends Record<string, WebhookEventDef>>(defs: T): T {
  return defs;
}

export const TASKS_WEBHOOK_EVENTS = defineWebhookEvents({
  'tasks.task.created': { service: 'tasks', version: 1 },
  'tasks.task.completed': { service: 'tasks', version: 1 },
  'tasks.task.cancelled': { service: 'tasks', version: 1 },
});

export const DOCUMENTS_WEBHOOK_EVENTS = defineWebhookEvents({
  'documents.document.registered': { service: 'documents', version: 1 },
  'documents.document.signed': { service: 'documents', version: 1 },
});

export const WORKSPACES_WEBHOOK_EVENTS = defineWebhookEvents({
  'workspaces.member.joined': { service: 'workspaces', version: 1 },
  'workspaces.member.left': { service: 'workspaces', version: 1 },
});

const REGISTRY_RAW = {
  ...TASKS_WEBHOOK_EVENTS,
  ...DOCUMENTS_WEBHOOK_EVENTS,
  ...WORKSPACES_WEBHOOK_EVENTS,
} as const satisfies Record<string, WebhookEventDef>;

export type WebhookEventKey = keyof typeof REGISTRY_RAW;
export const WEBHOOK_EVENT_REGISTRY: Readonly<Record<WebhookEventKey, WebhookEventDef>> = REGISTRY_RAW;
export const WEBHOOK_EVENT_KEYS = Object.keys(WEBHOOK_EVENT_REGISTRY) as WebhookEventKey[];

export function isWebhookEventKey(value: unknown): value is WebhookEventKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_REGISTRY, value);
}

/** События, сгруппированные по сервису (чекбоксы формы endpoint'а). */
export function webhookEventsByService(): Array<{ service: string; events: WebhookEventKey[] }> {
  const map = new Map<string, WebhookEventKey[]>();
  for (const key of WEBHOOK_EVENT_KEYS) {
    const s = WEBHOOK_EVENT_REGISTRY[key].service;
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(key);
  }
  return [...map.entries()].map(([service, events]) => ({ service, events }));
}

/** Служебные события endpoint'а (не из реестра продюсеров). */
export const WEBHOOK_SYSTEM_EVENTS = {
  ping: 'webhook.ping',
  test: 'webhook.test',
} as const;
