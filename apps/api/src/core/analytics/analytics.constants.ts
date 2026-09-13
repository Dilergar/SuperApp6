import type { AnalyticsPlatform, AnalyticsQuarantineReason } from '@superapp/shared';

/** Отдельный stream приёма (не EventBus: другой профиль нагрузки и своя политика сброса). */
export const ANALYTICS_STREAM = 'superapp:analytics';
export const ANALYTICS_GROUP = 'superapp:analytics-workers';

/** Версия конвейера приёма (колонка `ingest_version`). */
export const ANALYTICS_INGEST_VERSION = 1;

export const ANALYTICS_REDIS = {
  /** Отказ человека (TTL 5 мин): ставит `setOptOut`, читает консьюмер */
  optOut: (userId: string) => `analytics:optout:${userId}`,
  /** Кэш результата запроса Кабинета */
  query: (hash: string) => `analytics:q:${hash}`,
  /** Результат долгого запроса (report job) */
  reportJob: (id: string) => `analytics:job:${id}`,
  /** Время последнего роллапа (ISO) */
  rollupAt: 'analytics:rollup:last',
  /** Момент первого события в хранилище (ISO, без TTL: однажды найденный не меняется до ретенции) */
  firstEvent: 'analytics:first-event',
  /** Дни (в APP_TIMEZONE), куда легли новые события — их пересчитает крон */
  dirtyDays: 'analytics:dirty-days',
  /** Счётчики приёма за сутки UTC (hash: accepted/dropped/redacted/shed/blocked/optedOut) */
  counters: (day: string) => `analytics:counters:${day}`,
} as const;

export const ANALYTICS_JOBS = {
  rollupDay: 'analytics.rollup.day',
  userErase: 'analytics.user.erase',
  workspaceErase: 'analytics.workspace.erase',
  reportRun: 'analytics.report.run',
} as const;

/** Своя очередь джобов: тяжёлые пересчёты не сужают `default`. */
export const ANALYTICS_QUEUE = 'analytics';

export type AnalyticsCounter = 'accepted' | 'dropped' | 'redacted' | 'shed' | 'blocked' | 'optedOut';

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : v === 'true');
const int = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/**
 * Настройки движка из env. Читаются на вызове (после `validateEnv` в main.ts), а не
 * константами модуля — те вычислялись бы до разбора окружения.
 */
export function analyticsEnv() {
  return {
    enabled: bool(process.env.ANALYTICS_ENABLED, true),
    consumerEnabled: bool(process.env.ANALYTICS_CONSUMER_ENABLED, true),
    retentionDays: int(process.env.ANALYTICS_RAW_RETENTION_DAYS, 400),
    streamMaxLen: int(process.env.ANALYTICS_STREAM_MAXLEN, 2_000_000),
    kAnon: int(process.env.ANALYTICS_K_ANON, 20),
    internalPhonePrefixes: (process.env.ANALYTICS_INTERNAL_PHONE_PREFIXES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    readDatabaseUrl: process.env.ANALYTICS_READ_DATABASE_URL || null,
    queryTimeoutMs: int(process.env.ANALYTICS_QUERY_TIMEOUT_MS, 5000),
    timezone: process.env.APP_TIMEZONE || 'Asia/Almaty',
  };
}

/**
 * Нормализованное событие в stream'е и в outbox: личность и организация уже
 * ВЫВЕДЕНЫ сервером. `claimedWorkspaceId` — заголовок клиента, членство по нему
 * проверяет консьюмер (не подтвердилось — организация обнуляется).
 */
export interface AnalyticsIngestEvent {
  eventId: string;
  key: string;
  occurredAt: string;
  receivedAt: string;
  platform: AnalyticsPlatform;
  appVersion: string | null;
  userId: string | null;
  anonymousId: string | null;
  /** Организация, проверенная ДО нас (chokepoint запроса или доверенный сервер) */
  workspaceId: string | null;
  /** Организация из заголовка клиента — ещё не проверена */
  claimedWorkspaceId: string | null;
  role: string | null;
  sessionId: string | null;
  deviceId: string | null;
  loginSid: string | null;
  deviceClass: number | null;
  os: string | null;
  browser: string | null;
  locale: string | null;
  tz: string | null;
  route: string | null;
  refType: string | null;
  refId: string | null;
  props: Record<string, unknown>;
  sampleRate: number;
  /** Сигнал отказа браузера (`Sec-GPC: 1`) — действует как отказ на это событие */
  gpc: boolean;
}

/** Отказ приёма, который консьюмер запишет в карантин (на пути запроса БД нет). */
export interface AnalyticsIngestReject {
  key: string;
  reason: AnalyticsQuarantineReason;
  shape: Record<string, string>;
}

export interface AnalyticsStreamEntry {
  v: 1;
  events: AnalyticsIngestEvent[];
  rejects: AnalyticsIngestReject[];
}
