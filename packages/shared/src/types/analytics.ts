import type {
  AnalyticsAreaKey,
  AnalyticsClass,
  AnalyticsEventSource,
  AnalyticsEventStatus,
  AnalyticsQuarantineReason,
} from '../analytics';
import type {
  AnalyticsBreakdownBy,
  AnalyticsBreakdownMetric,
  AnalyticsFunnelMode,
  AnalyticsInterval,
  AnalyticsQueryInput,
  AnalyticsQueryType,
  AnalyticsRange,
  AnalyticsRetentionMode,
  AnalyticsTile,
  AnalyticsTrendMetric,
  AnalyticsUnit,
  AnalyticsVisibility,
  AnalyticsViz,
} from '../validation/analytics';

// ============================================================
// core/analytics — формы провода (обе стороны: API и клиенты)
// ============================================================

// ---- Приём ----

export interface AnalyticsCollectResultDto {
  accepted: number;
  dropped: number;
}

export interface AnalyticsIdentifyResultDto {
  /** Эта привязка стала первой для анонимного id */
  linked: boolean;
  /** Анонимный id уже привязан к ДРУГОМУ аккаунту — склейка по нему остановлена */
  contested: boolean;
}

export interface AnalyticsConsentDto {
  optOut: boolean;
}

// ---- Результаты запросов ----

/** Значение ячейки: `null` + `masked` — меньше k человек, скрыто ради приватности. */
export interface AnalyticsPointDto {
  /** Начало интервала `YYYY-MM-DD` (день в `APP_TIMEZONE`) */
  period: string;
  value: number | null;
  masked?: boolean;
}

export interface AnalyticsSeriesDto {
  /** Ключ серии: `total`, ключ области, тарифа, платформы, id организации или `other` */
  key: string;
  points: AnalyticsPointDto[];
  /** Итог серии за период (среднее для долей и медиан) */
  total: number | null;
  masked?: boolean;
}

export interface AnalyticsTrendResultDto {
  type: 'trend';
  metric: AnalyticsTrendMetric;
  interval: AnalyticsInterval;
  series: AnalyticsSeriesDto[];
  /** Тот же отрезок назад (при `compare`) — периоды сдвинуты к текущему для наложения */
  previous: AnalyticsSeriesDto[] | null;
  /** Последнее значение (dau/wau/mau/stickiness) либо сумма за период */
  current: number | null;
  previousValue: number | null;
}

export interface AnalyticsFunnelStepDto {
  eventKey: string;
  /** Альтернативы шага «любое из» (пусто — шаг из одного события) */
  orEventKeys: string[];
  count: number;
  /** Доля от предыдущего шага (0..1), у первого — 1 */
  fromPrevious: number | null;
  fromStart: number | null;
  /** Медиана секунд от предыдущего шага */
  medianSecondsFromPrevious: number | null;
  previousCount: number | null;
}

export interface AnalyticsFunnelBreakdownDto {
  key: string;
  counts: Array<number | null>;
  masked: boolean;
}

export interface AnalyticsFunnelResultDto {
  type: 'funnel';
  unit: AnalyticsUnit;
  mode: AnalyticsFunnelMode;
  windowDays: number;
  steps: AnalyticsFunnelStepDto[];
  /** Индекс шага с самым большим отвалом (null — отвала нет) */
  biggestDropIndex: number | null;
  breakdown: AnalyticsFunnelBreakdownDto[] | null;
}

export interface AnalyticsRetentionCohortDto {
  cohort: string;
  size: number | null;
  masked: boolean;
  /** Доля вернувшихся по дню N / корзине (0..1); null — ещё не наступило или скрыто */
  values: Array<number | null>;
}

export interface AnalyticsRetentionResultDto {
  type: 'retention';
  mode: AnalyticsRetentionMode;
  unit: AnalyticsUnit;
  /** Подписи колонок: номер дня (`1`, `7`) или корзина (`2-7`) */
  columns: string[];
  /** Средневзвешенная кривая по когортам */
  curve: Array<number | null>;
  cohorts: AnalyticsRetentionCohortDto[];
}

export interface AnalyticsBreakdownRowDto {
  key: string;
  value: number | null;
  previous: number | null;
  masked: boolean;
}

export interface AnalyticsBreakdownResultDto {
  type: 'breakdown';
  by: AnalyticsBreakdownBy;
  metric: AnalyticsBreakdownMetric;
  perActiveWorkspace: boolean;
  rows: AnalyticsBreakdownRowDto[];
  /** Сумма хвоста за пределами `limit` (null — хвоста нет или метрика неаддитивна) */
  other: number | null;
}

export interface AnalyticsLifecycleBucketDto {
  period: string;
  new: number;
  current: number;
  resurrected: number;
  /** Уснувшие — отрицательная часть стопки (число положительное) */
  dormant: number;
}

export interface AnalyticsLifecycleResultDto {
  type: 'lifecycle';
  interval: AnalyticsInterval;
  unit: AnalyticsUnit;
  buckets: AnalyticsLifecycleBucketDto[];
}

export interface AnalyticsAdoptionServiceDto {
  service: AnalyticsAreaKey;
  active: number | null;
  /** Доля активных, коснувшихся сервиса (0..1) */
  share: number | null;
  previousShare: number | null;
  /** Медиана дней использования за период среди коснувшихся */
  medianDays: number | null;
  masked: boolean;
}

export interface AnalyticsAdoptionPlanDto {
  planKey: string;
  activeTotal: number | null;
  services: AnalyticsAdoptionServiceDto[];
  masked: boolean;
}

export interface AnalyticsAdoptionResultDto {
  type: 'adoption';
  unit: AnalyticsUnit;
  activeTotal: number;
  services: AnalyticsAdoptionServiceDto[];
  byPlan: AnalyticsAdoptionPlanDto[] | null;
}

export interface AnalyticsJourneyPairDto {
  from: AnalyticsAreaKey;
  to: AnalyticsAreaKey;
  count: number | null;
  users: number | null;
  masked: boolean;
}

export interface AnalyticsJourneysResultDto {
  type: 'journeys';
  pairs: AnalyticsJourneyPairDto[];
}

export type AnalyticsQueryResultDto =
  | AnalyticsTrendResultDto
  | AnalyticsFunnelResultDto
  | AnalyticsRetentionResultDto
  | AnalyticsBreakdownResultDto
  | AnalyticsLifecycleResultDto
  | AnalyticsAdoptionResultDto
  | AnalyticsJourneysResultDto;

export interface AnalyticsQueryMetaDto {
  type: AnalyticsQueryType;
  range: AnalyticsRange;
  previousRange: AnalyticsRange | null;
  timezone: string;
  computedAt: string;
  /** Время последнего роллапа (null — роллапов ещё не было) */
  rollupAt: string | null;
  /** Первое событие в хранилище (null — событий нет вовсе): для честного пустого состояния */
  firstEventAt: string | null;
  cached: boolean;
  /** Порог k-анонимности */
  kAnon: number;
}

/** Ответ запроса: готовый результат или долгий расчёт в фоне (воронка > 90 дней). */
export type AnalyticsQueryResponseDto =
  | { status: 'ready'; result: AnalyticsQueryResultDto; meta: AnalyticsQueryMetaDto }
  | { status: 'pending'; jobId: string; meta: AnalyticsQueryMetaDto };

// ---- Каталог событий и качество ----

export interface AnalyticsEventCatalogItemDto {
  key: string;
  service: AnalyticsAreaKey;
  source: AnalyticsEventSource;
  class: AnalyticsClass;
  qualifying: boolean;
  anonymous: boolean;
  version: number;
  /** Статус реестра */
  registryStatus: AnalyticsEventStatus;
  /** Действующий статус (с учётом рубильника) */
  status: AnalyticsEventStatus;
  override: { status: 'live' | 'blocked'; reason: string | null; setBy: string | null; setAt: string } | null;
  /** Объём по дням за 14 дней (старые → новые) */
  volume14d: number[];
  volume7d: number;
  lastSeenDay: string | null;
  /** Enum/boolean-свойства — для фильтра шага воронки */
  enumProps: Array<{ prop: string; values: string[] }>;
}

export interface AnalyticsQuarantineItemDto {
  id: string;
  eventKey: string;
  reason: AnalyticsQuarantineReason;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Только имена и типы полей (значений нет) */
  sampleShape: Record<string, string>;
}

export interface AnalyticsQualityDto {
  quarantine: AnalyticsQuarantineItemDto[];
  stream: { length: number; maxLength: number; pending: number; lagSeconds: number | null };
  outboxBacklog: number;
  /** Счётчики за текущие сутки (UTC) */
  counters: { accepted: number; dropped: number; redacted: number; shed: number; blocked: number; optedOut: number };
  eventsLastHour: number;
  rollupAt: string | null;
  /** Первое событие в хранилище (null — событий ещё не было): честное пустое состояние раздела */
  firstEventAt: string | null;
  timezone: string;
}

// ---- Отчёты и дашборды ----

export interface AnalyticsReportDto {
  id: string;
  /** Название, введённое человеком (у системного — null, подпись по `systemKey`) */
  title: string | null;
  systemKey: string | null;
  query: AnalyticsQueryInput;
  viz: AnalyticsViz | null;
  visibility: AnalyticsVisibility;
  createdBy: string | null;
  /** Может ли зритель править (автор или `analytics.manage`; системные — никто) */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsDashboardDto {
  id: string;
  title: string | null;
  systemKey: string | null;
  tiles: AnalyticsTile[];
  visibility: AnalyticsVisibility;
  createdBy: string | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsDashboardDetailDto extends AnalyticsDashboardDto {
  /** Отчёты плиток (видимые зрителю) — одним ответом, без N запросов */
  reports: AnalyticsReportDto[];
}

// ---- Панель «Активность» карточки 360 (только агрегаты) ----

export interface AnalyticsActivityPanelDto {
  entity: 'user' | 'workspace';
  lastActiveDay: string | null;
  activeDays28: number;
  topServices28: Array<{ service: AnalyticsAreaKey; days: number }>;
  platforms28: Array<{ platform: string; days: number }>;
  deniedKeys28: Array<{ key: string; count: number }>;
  /** Только у организации */
  members: { total: number; active28: number } | null;
  adoption28: Array<{ service: AnalyticsAreaKey; share: number }> | null;
}
