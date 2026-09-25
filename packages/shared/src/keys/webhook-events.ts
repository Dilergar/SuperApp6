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

/**
 * Обязательные события стирания (модель Shopify customers/redact · shop/redact): уходят ВСЕМ
 * активным адресам организации без подписки — интеграция обязана удалить у себя данные.
 *  - `lifecycle.person.redact` — человек стёр аккаунт: каждой организации, где он состоял
 *    (срок исполнения 30 дней, кроме законных оснований хранения);
 *  - `lifecycle.workspace.redact` — через 48 часов после архивации организации (интеграции
 *    отключены): удалить данные организации.
 */
export const LIFECYCLE_WEBHOOK_EVENTS = defineWebhookEvents({
  'lifecycle.person.redact': { service: 'lifecycle', version: 1 },
  'lifecycle.workspace.redact': { service: 'lifecycle', version: 1 },
});
/** События, которые не выбираются подпиской (обязательны для каждого адреса). */
export const WEBHOOK_MANDATORY_EVENTS = Object.keys(LIFECYCLE_WEBHOOK_EVENTS) as ReadonlyArray<keyof typeof LIFECYCLE_WEBHOOK_EVENTS>;

export const WORKSPACES_WEBHOOK_EVENTS = defineWebhookEvents({
  'workspaces.member.joined': { service: 'workspaces', version: 1 },
  'workspaces.member.left': { service: 'workspaces', version: 1 },
});

/**
 * Стрим журнала безопасности организации во внешний SIEM (core/audit): одно событие на
 * категорию журнала — `security.<категория>.recorded`, payload `SecurityWebhookPayload`
 * (OCSF без IP, UA и имён). Только категории, чьи события организация видит сама: вход,
 * сессии и аккаунт людей — их личное, в журнал организации (и стрим) не попадают. Подписка
 * требует тарифа `audit.stream` (402).
 */
export const SECURITY_WEBHOOK_EVENTS = defineWebhookEvents({
  'security.org.recorded': { service: 'security', version: 1 },
  'security.keys.recorded': { service: 'security', version: 1 },
  'security.data.recorded': { service: 'security', version: 1 },
  'security.consents.recorded': { service: 'security', version: 1 },
  'security.detect.recorded': { service: 'security', version: 1 },
  'security.sharing.recorded': { service: 'security', version: 1 },
  'security.files.recorded': { service: 'security', version: 1 },
});

const REGISTRY_RAW = {
  ...TASKS_WEBHOOK_EVENTS,
  ...DOCUMENTS_WEBHOOK_EVENTS,
  ...WORKSPACES_WEBHOOK_EVENTS,
  ...LIFECYCLE_WEBHOOK_EVENTS,
  ...SECURITY_WEBHOOK_EVENTS,
} as const satisfies Record<string, WebhookEventDef>;

export type WebhookEventKey = keyof typeof REGISTRY_RAW;
export const WEBHOOK_EVENT_REGISTRY: Readonly<Record<WebhookEventKey, WebhookEventDef>> = REGISTRY_RAW;
export const WEBHOOK_EVENT_KEYS = Object.keys(WEBHOOK_EVENT_REGISTRY) as WebhookEventKey[];

export function isWebhookEventKey(value: unknown): value is WebhookEventKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_REGISTRY, value);
}

/** События, сгруппированные по сервису (чекбоксы формы endpoint'а). */
/** Ключи, на которые подписываются (обязательные события уходят всем адресам без подписки). */
export const WEBHOOK_SUBSCRIBABLE_KEYS = WEBHOOK_EVENT_KEYS.filter((k) => !(WEBHOOK_MANDATORY_EVENTS as readonly string[]).includes(k));

/** Каталог подписки по сервисам — без обязательных событий. */
export function webhookEventsByService(): Array<{ service: string; events: WebhookEventKey[] }> {
  const map = new Map<string, WebhookEventKey[]>();
  for (const key of WEBHOOK_SUBSCRIBABLE_KEYS) {
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
