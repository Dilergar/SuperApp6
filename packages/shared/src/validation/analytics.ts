import { z } from 'zod';
import {
  ANALYTICS_AREA_KEYS,
  ANALYTICS_EVENT_KEYS,
  ANALYTICS_LIMITS,
  ANALYTICS_PLATFORMS,
  ANALYTICS_SOURCES,
} from '../analytics';

// ============================================================
// core/analytics — Zod приёма, языка запросов (DSL), отчётов, дашбордов и команд
// ============================================================

const areaEnum = z.enum(ANALYTICS_AREA_KEYS as [string, ...string[]]);
const eventKeyEnum = z.enum(ANALYTICS_EVENT_KEYS as [string, ...string[]]);
const uuid = z.string().uuid();

// ---- Приём ----

/** Примитив свойства на проводе (строгая схема ключа проверяется дальше по реестру). */
const wirePropValue = z.union([z.string().max(ANALYTICS_LIMITS.maxStringLength), z.number().finite(), z.boolean(), z.null()]);

/**
 * Событие клиента. `.strict()` — несущее: поле личности в теле (`userId`,
 * `workspaceId`, `phone`) — ОШИБКА схемы, а не «игнор». Личность сервер выводит
 * из JWT, организацию — из `X-Workspace-Id` с проверкой членства.
 */
export const analyticsClientEventSchema = z
  .object({
    eventId: uuid,
    key: z.string().min(3).max(100),
    occurredAt: z.string().datetime({ offset: true }),
    props: z.record(z.string().max(64), wirePropValue).optional(),
    sessionId: uuid.optional(),
    deviceId: uuid.optional(),
    anonymousId: uuid.optional(),
    route: z.string().max(ANALYTICS_LIMITS.maxRouteLength).optional(),
    sampleRate: z.number().gt(0).max(1).optional(),
  })
  .strict();
export type AnalyticsClientEvent = z.infer<typeof analyticsClientEventSchema>;

/**
 * Батч клиента. События разбираются ПО ОДНОМУ: плохое уходит в `dropped` и карантин,
 * хорошие принимаются — отказ SDK никогда не ломает интерфейс.
 */
export const analyticsCollectSchema = z
  .object({
    sentAt: z.string().datetime({ offset: true }),
    app: z
      .object({
        platform: z.enum(['web', 'ios', 'android']),
        version: z.string().max(32).regex(/^[A-Za-z0-9_.+-]+$/).optional(),
      })
      .strict(),
    context: z
      .object({
        locale: z.string().max(16).regex(/^[A-Za-z-]+$/).optional(),
        tz: z.string().max(64).regex(/^[A-Za-z0-9_+\-/]+$/).optional(),
        gpc: z.boolean().optional(),
      })
      .strict()
      .optional(),
    batch: z.array(z.unknown()).min(1).max(ANALYTICS_LIMITS.maxBatch),
  })
  .strict();
export type AnalyticsCollectInput = z.infer<typeof analyticsCollectSchema>;

export const analyticsIdentifySchema = z.object({ anonymousId: uuid }).strict();
export type AnalyticsIdentifyInput = z.infer<typeof analyticsIdentifySchema>;

export const analyticsConsentSchema = z.object({ optOut: z.boolean() }).strict();
export type AnalyticsConsentInput = z.infer<typeof analyticsConsentSchema>;

// ---- Язык запросов (DSL) ----

export const ANALYTICS_QUERY_TYPES = ['trend', 'funnel', 'retention', 'breakdown', 'lifecycle', 'adoption', 'journeys'] as const;
export type AnalyticsQueryType = (typeof ANALYTICS_QUERY_TYPES)[number];

/**
 * Метрики тренда. Определения — `apps/api/src/core/analytics/analytics.metrics.ts`
 * (день — календарный в `APP_TIMEZONE`; активность — квалифицирующее событие):
 * dau · wau (скользящие 7 дней) · mau (скользящие 28) · stickiness (dau/mau) ·
 * active_workspaces · new_users (первый активный день) · events · event_users ·
 * sessions · session_p50 (медиана длительности, с).
 */
export const ANALYTICS_TREND_METRICS = [
  'dau',
  'wau',
  'mau',
  'stickiness',
  'active_workspaces',
  'new_users',
  'events',
  'event_users',
  'sessions',
  'session_p50',
] as const;
export type AnalyticsTrendMetric = (typeof ANALYTICS_TREND_METRICS)[number];

export const ANALYTICS_INTERVALS = ['day', 'week', 'month'] as const;
export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];

export const ANALYTICS_UNITS = ['user', 'workspace'] as const;
export type AnalyticsUnit = (typeof ANALYTICS_UNITS)[number];

/** Разбиение серий тренда. `workspace` и `plan` подчиняются k-анонимности. */
export const ANALYTICS_TREND_BREAKDOWNS = ['service', 'plan', 'platform', 'workspace'] as const;
export type AnalyticsTrendBreakdown = (typeof ANALYTICS_TREND_BREAKDOWNS)[number];

export const ANALYTICS_BREAKDOWN_BY = ['service', 'event', 'plan', 'platform', 'workspace', 'denied_key'] as const;
export type AnalyticsBreakdownBy = (typeof ANALYTICS_BREAKDOWN_BY)[number];

export const ANALYTICS_BREAKDOWN_METRICS = ['events', 'users', 'workspaces'] as const;
export type AnalyticsBreakdownMetric = (typeof ANALYTICS_BREAKDOWN_METRICS)[number];

export const ANALYTICS_FUNNEL_MODES = ['ordered', 'strict', 'any'] as const;
export type AnalyticsFunnelMode = (typeof ANALYTICS_FUNNEL_MODES)[number];

export const ANALYTICS_RETENTION_MODES = ['n_day', 'unbounded', 'bracket'] as const;
export type AnalyticsRetentionMode = (typeof ANALYTICS_RETENTION_MODES)[number];

/** Контекст строк: все · личное пространство · организации. */
export const ANALYTICS_CONTEXTS = ['all', 'personal', 'workspace'] as const;
export type AnalyticsContext = (typeof ANALYTICS_CONTEXTS)[number];

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

export const analyticsRangeSchema = z
  .object({ from: dayString, to: dayString })
  .strict()
  .refine((r) => !Number.isNaN(dayMs(r.from)) && !Number.isNaN(dayMs(r.to)), { message: 'invalid date', path: ['from'] })
  .refine((r) => dayMs(r.from) <= dayMs(r.to), { message: 'from must not be after to', path: ['from'] })
  .refine((r) => (dayMs(r.to) - dayMs(r.from)) / 86_400_000 + 1 <= ANALYTICS_LIMITS.queryMaxRangeDays, {
    message: `at most ${ANALYTICS_LIMITS.queryMaxRangeDays} days`,
    path: ['to'],
  });
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

/** Сколько дней в диапазоне (включительно). */
export const analyticsRangeDays = (r: AnalyticsRange): number => Math.round((dayMs(r.to) - dayMs(r.from)) / 86_400_000) + 1;

export const analyticsFiltersSchema = z
  .object({
    services: z.array(areaEnum).max(20).optional(),
    eventKeys: z.array(eventKeyEnum).max(20).optional(),
    platforms: z.array(z.enum(ANALYTICS_PLATFORMS)).max(4).optional(),
    sources: z.array(z.enum(ANALYTICS_SOURCES)).max(3).optional(),
    planKeys: z.array(z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/)).max(20).optional(),
    context: z.enum(ANALYTICS_CONTEXTS).optional(),
    workspaceId: uuid.optional(),
  })
  .strict();
export type AnalyticsFilters = z.infer<typeof analyticsFiltersSchema>;

const baseQuery = {
  range: analyticsRangeSchema,
  /** Тот же отрезок назад — считается вторым запросом, дельта в ответе */
  compare: z.boolean().default(false),
  filters: analyticsFiltersSchema.default({}),
  /** Исключить сотрудников платформы и тестовые номера (по умолчанию — да) */
  excludeInternal: z.boolean().default(true),
};

export const analyticsTrendQuerySchema = z
  .object({
    type: z.literal('trend'),
    ...baseQuery,
    metric: z.enum(ANALYTICS_TREND_METRICS),
    /** Для events / event_users: одно событие (иначе — все) */
    eventKey: eventKeyEnum.optional(),
    /** Интервал для events / event_users / new_users / sessions; dau/wau/mau — всегда по дням */
    interval: z.enum(ANALYTICS_INTERVALS).default('day'),
    breakdown: z.enum(ANALYTICS_TREND_BREAKDOWNS).optional(),
  })
  .strict();

export const analyticsFunnelStepSchema = z
  .object({
    eventKey: eventKeyEnum,
    /** Шаг засчитывается ЛЮБЫМ из событий: основное + альтернативы («создал задачу, событие или чат») */
    orEventKeys: z.array(eventKeyEnum).min(1).max(ANALYTICS_LIMITS.maxFunnelStepAlternatives).optional(),
    /** Фильтр по enum/boolean-свойству реестра (конструктор предлагает только их) */
    where: z
      .object({ prop: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/), value: z.string().min(1).max(64) })
      .strict()
      .optional(),
  })
  .strict()
  // Свойство — часть схемы ОДНОГО события: у шага «любое из» фильтра по свойству нет
  .refine((s) => !(s.where && s.orEventKeys?.length), { message: 'a property filter applies to a single-event step only', path: ['where'] })
  .refine((s) => !s.orEventKeys || new Set([s.eventKey, ...s.orEventKeys]).size === s.orEventKeys.length + 1, {
    message: 'step events must be distinct',
    path: ['orEventKeys'],
  });
export type AnalyticsFunnelStep = z.infer<typeof analyticsFunnelStepSchema>;

export const analyticsFunnelQuerySchema = z
  .object({
    type: z.literal('funnel'),
    ...baseQuery,
    steps: z.array(analyticsFunnelStepSchema).min(2).max(ANALYTICS_LIMITS.maxFunnelSteps),
    windowDays: z.number().int().min(1).max(ANALYTICS_LIMITS.funnelMaxWindowDays).default(7),
    mode: z.enum(ANALYTICS_FUNNEL_MODES).default('ordered'),
    unit: z.enum(ANALYTICS_UNITS).default('user'),
    breakdown: z.enum(['platform', 'plan']).optional(),
  })
  .strict()
  .refine((q) => !(q.mode === 'strict' && q.unit === 'workspace'), {
    message: 'strict order is defined for people only',
    path: ['mode'],
  });

export const analyticsRetentionQuerySchema = z
  .object({
    type: z.literal('retention'),
    ...baseQuery,
    mode: z.enum(ANALYTICS_RETENTION_MODES).default('n_day'),
    /** Горизонт кривой, дней */
    days: z.number().int().min(1).max(90).default(28),
    /** Когорта — первое указанное событие (иначе — первое квалифицирующее) */
    startEvent: eventKeyEnum.optional(),
    /** Возврат — указанное событие (иначе — любое квалифицирующее) */
    returnEvent: eventKeyEnum.optional(),
    unit: z.enum(ANALYTICS_UNITS).default('user'),
  })
  .strict();

export const analyticsBreakdownQuerySchema = z
  .object({
    type: z.literal('breakdown'),
    ...baseQuery,
    by: z.enum(ANALYTICS_BREAKDOWN_BY),
    metric: z.enum(ANALYTICS_BREAKDOWN_METRICS).default('users'),
    eventKey: eventKeyEnum.optional(),
    /** Нормировать на активную организацию (сравнение тарифов) */
    perActiveWorkspace: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const analyticsLifecycleQuerySchema = z
  .object({
    type: z.literal('lifecycle'),
    ...baseQuery,
    interval: z.enum(ANALYTICS_INTERVALS).default('week'),
    unit: z.enum(ANALYTICS_UNITS).default('user'),
  })
  .strict();

export const analyticsAdoptionQuerySchema = z
  .object({
    type: z.literal('adoption'),
    ...baseQuery,
    unit: z.enum(ANALYTICS_UNITS).default('user'),
    /** Разрез по тарифу (матрица тариф × сервис) */
    byPlan: z.boolean().default(false),
  })
  .strict();

export const analyticsJourneysQuerySchema = z
  .object({
    type: z.literal('journeys'),
    ...baseQuery,
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

/**
 * Запрос отчёта. Discriminated union: у каждого вида свой набор уточнений, общие —
 * диапазон, сравнение, фильтры, исключение внутренних аккаунтов.
 */
export const analyticsQuerySchema = z.union([
  analyticsTrendQuerySchema,
  analyticsFunnelQuerySchema,
  analyticsRetentionQuerySchema,
  analyticsBreakdownQuerySchema,
  analyticsLifecycleQuerySchema,
  analyticsAdoptionQuerySchema,
  analyticsJourneysQuerySchema,
]);
export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;
/** Вход ДО дефолтов (форма, которую собирает конструктор). */
export type AnalyticsQueryDraft = z.input<typeof analyticsQuerySchema>;

// ---- Отчёты и дашборды ----

export const ANALYTICS_VISIBILITIES = ['shared', 'private'] as const;
export type AnalyticsVisibility = (typeof ANALYTICS_VISIBILITIES)[number];

/** Вид отображения плитки. */
export const ANALYTICS_VIZ = ['stat', 'line', 'bar', 'stack', 'funnel', 'cohort', 'curve', 'scatter', 'table'] as const;
export type AnalyticsViz = (typeof ANALYTICS_VIZ)[number];

const titleSchema = z.string().trim().min(1).max(ANALYTICS_LIMITS.maxTitleLength);

export const analyticsReportCreateSchema = z
  .object({
    title: titleSchema,
    query: analyticsQuerySchema,
    viz: z.enum(ANALYTICS_VIZ).optional(),
    visibility: z.enum(ANALYTICS_VISIBILITIES).default('shared'),
  })
  .strict();
export type AnalyticsReportCreateInput = z.infer<typeof analyticsReportCreateSchema>;

export const analyticsReportUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    query: analyticsQuerySchema.optional(),
    viz: z.enum(ANALYTICS_VIZ).nullable().optional(),
    visibility: z.enum(ANALYTICS_VISIBILITIES).optional(),
  })
  .strict();
export type AnalyticsReportUpdateInput = z.infer<typeof analyticsReportUpdateSchema>;

export const analyticsTileSchema = z
  .object({
    reportId: uuid,
    span: z.union([z.literal(4), z.literal(6), z.literal(12)]),
    viz: z.enum(ANALYTICS_VIZ).optional(),
  })
  .strict();
export type AnalyticsTile = z.infer<typeof analyticsTileSchema>;

export const analyticsDashboardCreateSchema = z
  .object({
    title: titleSchema,
    tiles: z.array(analyticsTileSchema).max(ANALYTICS_LIMITS.maxTiles).default([]),
    visibility: z.enum(ANALYTICS_VISIBILITIES).default('shared'),
  })
  .strict();
export type AnalyticsDashboardCreateInput = z.infer<typeof analyticsDashboardCreateSchema>;

export const analyticsDashboardUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    tiles: z.array(analyticsTileSchema).max(ANALYTICS_LIMITS.maxTiles).optional(),
    visibility: z.enum(ANALYTICS_VISIBILITIES).optional(),
  })
  .strict();
export type AnalyticsDashboardUpdateInput = z.infer<typeof analyticsDashboardUpdateSchema>;

// ---- Команды кабинета ----

export const analyticsEventSetStatusInputSchema = z
  .object({ eventKey: eventKeyEnum, status: z.enum(['live', 'blocked']) })
  .strict();
export type AnalyticsEventSetStatusInput = z.infer<typeof analyticsEventSetStatusInputSchema>;

export const analyticsUserForgetInputSchema = z.object({ userId: uuid }).strict();
export type AnalyticsUserForgetInput = z.infer<typeof analyticsUserForgetInputSchema>;

export const analyticsRollupRebuildInputSchema = z
  .object({ from: dayString, to: dayString })
  .strict()
  .refine((r) => dayMs(r.from) <= dayMs(r.to), { message: 'from must not be after to', path: ['from'] })
  .refine((r) => (dayMs(r.to) - dayMs(r.from)) / 86_400_000 + 1 <= ANALYTICS_LIMITS.queryMaxRangeDays, {
    message: `at most ${ANALYTICS_LIMITS.queryMaxRangeDays} days`,
    path: ['to'],
  });
export type AnalyticsRollupRebuildInput = z.infer<typeof analyticsRollupRebuildInputSchema>;
