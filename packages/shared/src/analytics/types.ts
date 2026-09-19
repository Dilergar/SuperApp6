import { z } from 'zod';

// ============================================================
// core/analytics (21-й платформенный движок) — словарь реестра СОБЫТИЙ
// ============================================================
// Событие — ДЕКЛАРИРУЕМАЯ сущность (Segment Protocols tracking plan, Amplitude
// Data, Snowplow schema registry), а не строка в коде. Реестр называет смысл:
// сервис-владелец, источник, класс (приоритет и согласие), считается ли активностью,
// и СТРОГУЮ схему свойств. Слова (название и описание для каталога Кабинета) живут
// в `@superapp/i18n` (`analytics.events.<key>.title|description`).
//
// Правило источника: «это произошло?» — пишет сервер из транзакции мутации;
// «увидели/попытались?» — пишет клиент. Имена не пересекаются — двойного счёта нет.

/**
 * Класс события — приоритет приёма и отношение к согласию:
 * - business — факт работы сервиса (создал задачу, упёрся в тариф): пишется ВСЕГДА,
 *   его не сбрасывает ни отказ человека, ни перегрузка приёма;
 * - product — действие в интерфейсе: уважает отказ, сбрасывается при 95 % очереди;
 * - telemetry — служебный фон (открыл страницу): уважает отказ, сбрасывается первым (80 %).
 */
export const ANALYTICS_CLASSES = ['business', 'product', 'telemetry'] as const;
export type AnalyticsClass = (typeof ANALYTICS_CLASSES)[number];
/** Код класса в колонке `analytics.events.class` (smallint). */
export const ANALYTICS_CLASS_CODE: Record<AnalyticsClass, number> = { business: 0, product: 1, telemetry: 2 };

/** Кто вправе прислать событие: сервер (из транзакции), клиент (HTTP) или оба. */
export const ANALYTICS_EVENT_SOURCES = ['server', 'client', 'both'] as const;
export type AnalyticsEventSource = (typeof ANALYTICS_EVENT_SOURCES)[number];

/**
 * Жизненный цикл ключа в реестре (рубильник без деплоя — `AnalyticsEventOverride`):
 * - live — принимается;
 * - planned — объявлен заранее, отправителя в коде ещё нет (появится вместе с фичей):
 *   принимается как live, в каталоге помечен; страж `check:analytics` требует перевести
 *   ключ в live, как только его начали отправлять;
 * - deprecated — принимается, в каталоге помечен, новые места его не зовут;
 * - blocked — отбрасывается на приёме (счётчик drop).
 */
export const ANALYTICS_EVENT_STATUSES = ['live', 'planned', 'deprecated', 'blocked'] as const;
export type AnalyticsEventStatus = (typeof ANALYTICS_EVENT_STATUSES)[number];

/** Платформа клиента. `source` в колонке выводится из неё (web/mobile/server). */
export const ANALYTICS_PLATFORMS = ['web', 'ios', 'android', 'server'] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

/** Источник строки (smallint): веб, мобильный клиент, сервер. */
export const ANALYTICS_SOURCES = ['web', 'mobile', 'server'] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];
export const ANALYTICS_SOURCE_CODE: Record<AnalyticsSource, number> = { web: 0, mobile: 1, server: 2 };
export const analyticsSourceOf = (platform: AnalyticsPlatform): AnalyticsSource =>
  platform === 'server' ? 'server' : platform === 'web' ? 'web' : 'mobile';

/** Контекст строки (smallint `owner_type`): личное пространство, организация, без личности. */
export const ANALYTICS_OWNER_TYPES = ['personal', 'workspace', 'anonymous'] as const;
export type AnalyticsOwnerType = (typeof ANALYTICS_OWNER_TYPES)[number];
export const ANALYTICS_OWNER_CODE: Record<AnalyticsOwnerType, number> = { personal: 0, workspace: 1, anonymous: 2 };

/** Грубый класс устройства (smallint) — из User-Agent на приёме; сам UA не хранится. */
export const ANALYTICS_DEVICE_CLASSES = ['desktop', 'mobile', 'tablet', 'other'] as const;
export type AnalyticsDeviceClass = (typeof ANALYTICS_DEVICE_CLASSES)[number];

/**
 * Области продукта — ОДИН словарь для владельца события (первый сегмент ключа) и
 * для сервиса страницы (`serviceOfRoute`). `product` — сервисы, чьё использование
 * меряют adoption и матрица вовлечённости; `platform` — инфраструктура и каркас
 * (вход, профиль, навигация), в adoption не участвуют. Порядок = порядок в UI.
 * Подпись — `analytics.areas.<key>` в трёх каталогах.
 */
export const ANALYTICS_AREAS = {
  dashboard: { kind: 'product', order: 10 },
  tasks: { kind: 'product', order: 20 },
  calendar: { kind: 'product', order: 30 },
  messenger: { kind: 'product', order: 40 },
  circles: { kind: 'product', order: 50 },
  notes: { kind: 'product', order: 60 },
  drive: { kind: 'product', order: 70 },
  docs: { kind: 'product', order: 75 },
  finance: { kind: 'product', order: 80 },
  wallet: { kind: 'product', order: 85 },
  shop: { kind: 'product', order: 90 },
  recorder: { kind: 'product', order: 100 },
  approvals: { kind: 'product', order: 110 },
  sign: { kind: 'product', order: 120 },
  workspaces: { kind: 'product', order: 130 },
  staff: { kind: 'product', order: 140 },
  objects: { kind: 'product', order: 150 },
  documents: { kind: 'product', order: 160 },
  counterparties: { kind: 'product', order: 170 },
  hr: { kind: 'product', order: 180 },
  processes: { kind: 'product', order: 190 },
  office: { kind: 'product', order: 200 },
  navigation: { kind: 'platform', order: 900 },
  landing: { kind: 'platform', order: 905 },
  auth: { kind: 'platform', order: 910 },
  profile: { kind: 'platform', order: 920 },
  notifications: { kind: 'platform', order: 930 },
  entitlements: { kind: 'platform', order: 940 },
  share: { kind: 'platform', order: 950 },
  analytics: { kind: 'platform', order: 960 },
  /** Ключи, боты, личные токены (core/keys) и исходящие вебхуки (core/webhooks) */
  keys: { kind: 'platform', order: 970 },
  webhooks: { kind: 'platform', order: 975 },
  /** Согласия, документы платформы, «Мои данные» (core/consents) */
  consents: { kind: 'platform', order: 980 },
  platform: { kind: 'platform', order: 970 },
  other: { kind: 'platform', order: 999 },
} as const satisfies Record<string, { kind: 'product' | 'platform'; order: number }>;

export type AnalyticsAreaKey = keyof typeof ANALYTICS_AREAS;
export const ANALYTICS_AREA_KEYS = Object.keys(ANALYTICS_AREAS) as AnalyticsAreaKey[];
export const ANALYTICS_PRODUCT_AREAS = ANALYTICS_AREA_KEYS.filter((k) => ANALYTICS_AREAS[k].kind === 'product');

export function isAnalyticsArea(value: unknown): value is AnalyticsAreaKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANALYTICS_AREAS, value);
}

/** Схема свойств события: СТРОГИЙ объект плоских примитивов (глубина 1 ≤ разрешённых 2). */
export type AnalyticsPropsSchema = z.ZodObject<z.ZodRawShape, 'strict'>;

/** Декларация события. */
export interface AnalyticsEventDef {
  /** Владелец — совпадает с первым сегментом ключа (страж `check:analytics` и смоук бутстрапа) */
  service: AnalyticsAreaKey;
  /** `server` с HTTP → карантин `server_key_from_client` */
  source: AnalyticsEventSource;
  class: AnalyticsClass;
  /** Считается «активностью»: DAU/WAU/MAU, удержание, активная организация */
  qualifying: boolean;
  /** Разрешён на `/analytics/collect/anon` (до входа) */
  anonymous?: boolean;
  /** Allow-list свойств: `.strict()`, ≤ 12 ключей, строки ≤ 256, без свободного текста */
  props: AnalyticsPropsSchema;
  /** Версия схемы свойств (колонка `schema_version`) */
  version: number;
  status: AnalyticsEventStatus;
  /** Доля выборки 0 < sample ≤ 1 (по умолчанию 1): клиент бросает кубик, строка несёт `sample_rate` */
  sample?: number;
}

/** Хелпер объявления файла сервиса: сохраняет литеральные ключи и точные схемы. */
export function defineAnalyticsEvents<const T extends Record<string, AnalyticsEventDef>>(defs: T): T {
  return defs;
}

// ---- Строительные блоки свойств (только они: так свободный текст не пролезает) ----

/** Пустой набор свойств. */
export const noProps = () => z.object({}).strict();
/** Короткий машинный код (ключ тарифа, код отказа, тип ссылки) — не текст человека. */
export const propCode = (max = 64) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_.:-]+$/);
/** Шаблон маршрута (`/tasks/:id`) — без UUID и токенов, их вырезает `routeTemplateOf`. */
export const propRoute = () => z.string().min(1).max(ANALYTICS_LIMITS.maxRouteLength).regex(/^\/[A-Za-z0-9_.:\-/]*$/);
export const propCount = () => z.number().int().min(0).max(1_000_000);

/**
 * Запрещённые слова в ИМЕНАХ свойств (по словам camelCase/snake_case): свойство с
 * таким именем почти наверняка несёт персональные данные или свободный текст.
 * Единственный источник — страж `check:analytics` читает этот массив из файла.
 */
export const ANALYTICS_DENY_PROP_WORDS = [
  'phone',
  'iin',
  'bin',
  'email',
  'name',
  'iban',
  'card',
  'token',
  'address',
  'text',
  'body',
  'title',
] as const;

/** Слова имени свойства: `hasAssignee` → has, assignee; `referrer_route` → referrer, route. */
export function analyticsPropWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
}

export const ANALYTICS_LIMITS = {
  /** Событий в одном батче HTTP */
  maxBatch: 50,
  /** Клиент режет батч по этому размеру (под лимит тела Nest 100 КБ и sendBeacon) */
  maxBatchBytes: 60_000,
  /** Тело анонимной ручки — уже */
  anonMaxBodyBytes: 32_000,
  /** Свойств у события */
  maxPropKeys: 12,
  maxStringLength: 256,
  maxRouteLength: 256,
  /** Клампинг времени клиента: не старше receivedAt − 7 д, не новее receivedAt + 1 ч */
  clockSkewPastMs: 7 * 86_400_000,
  clockSkewFutureMs: 3_600_000,
  /** Сессия клиента: 30 мин бездействия или 24 ч всего */
  sessionIdleMs: 30 * 60_000,
  sessionMaxMs: 24 * 3_600_000,
  /** Очередь SDK: столько событий или столько мс — отправка */
  flushEvents: 20,
  flushIntervalMs: 5_000,
  /** Офлайн-кольцо SDK */
  offlineMaxEvents: 200,
  offlineMaxBytes: 128_000,
  offlineMaxAgeMs: 24 * 3_600_000,
  /** Окно ретро-склейки анонимных событий с аккаунтом (дни) */
  identityRelinkDays: 30,
  /** Воронка: интерактивный диапазон и максимальное окно конверсии (дни) */
  funnelInteractiveMaxDays: 90,
  funnelMaxWindowDays: 90,
  /** Диапазон любого запроса (дни) */
  queryMaxRangeDays: 400,
  /** Переходы между сервисами — интерактивный диапазон (дни) */
  journeysMaxDays: 90,
  /** Серий на графике; больше — «прочее» */
  maxSeries: 6,
  /** Шагов воронки */
  maxFunnelSteps: 8,
  /** Альтернатив у шага воронки («создал задачу, событие или чат» = основное + 2) */
  maxFunnelStepAlternatives: 4,
  /** Плиток дашборда */
  maxTiles: 24,
  /** Потолок живых ключей реестра (страж предупреждает) */
  maxLiveKeys: 150,
  /** Длина названия отчёта/дашборда */
  maxTitleLength: 120,
} as const;

/** Заголовки клиентского контекста для серверных событий (api-client шлёт их рядом с `X-Workspace-Id`). */
export const ANALYTICS_HEADERS = {
  session: 'X-Analytics-Session',
  device: 'X-Analytics-Device',
} as const;

/** Коды карантина (колонка `analytics_quarantine.reason`). */
export const ANALYTICS_QUARANTINE_REASONS = [
  'unknown_key',
  'schema',
  'blocked',
  'pii',
  'server_key_from_client',
  'anon_not_allowed',
] as const;
export type AnalyticsQuarantineReason = (typeof ANALYTICS_QUARANTINE_REASONS)[number];

/** Машиночитаемые коды отказов движка (`details.code`). Текст — `errors.analytics.*`. */
export const ANALYTICS_ERROR_CODES = {
  payloadTooLarge: 'analytics.payload_too_large',
  disabled: 'analytics.disabled',
  reportNotFound: 'analytics.report_not_found',
  dashboardNotFound: 'analytics.dashboard_not_found',
  notAuthor: 'analytics.not_author',
  systemReadOnly: 'analytics.system_read_only',
  rangeTooLong: 'analytics.range_too_long',
  queryTimeout: 'analytics.query_timeout',
} as const;
