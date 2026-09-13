import { Prisma } from '@prisma/client';
import type { AnalyticsFilters, AnalyticsRange } from '@superapp/shared';

// ============================================================
// Семантика метрик — ОДИН раз и детерминированно (Amplitude/Mixpanel-определения)
// ============================================================
// - День — календарный в APP_TIMEZONE (граница суток — полночь пояса платформы).
// - Активность — квалифицирующее событие реестра (`qualifying: true`).
// - DAU — различные люди с активностью за день; WAU — за скользящие 7 дней, MAU — 28.
// - Stickiness — DAU / MAU того же дня.
// - Активная организация — ≥ 1 участник с активностью в её контексте.
// - Новый — первый активный день в хранимой истории (сырьё и роллап субъекта живут
//   ретенцию сырья, поэтому «новый» — в пределах 13 месяцев).
// - Удержание: когорта — первое квалифицирующее (или указанное) событие; `n_day` — активен
//   ровно на день N; `unbounded` — активен в день N или позже; `bracket` — в корзине дней.
// - Воронка: `ordered` (дефолт) — шаги по порядку в окне от первого шага; `strict` — между
//   шагами нет других событий этой воронки; `any` — шаги 2..n в любом порядке в окне.
//   Первое вхождение первого шага, один субъект — одна конверсия. Окно ≤ 90 дней.
// - Adoption сервиса — активные в сервисе / активные всего; медиана дней использования.
// - Lifecycle: новые (первый период) · текущие (активны и в прошлом периоде) · вернувшиеся
//   (не были в прошлом, но раньше были) · уснувшие (были в прошлом, нет в текущем).
// - Тарифы — по СНИМКУ `plan_key` в событии; «без тарифа» — ключ `none`.
// - k-анонимность: ячейка разбиения по организации или тарифу с людьми < K скрыта.

export const PLAN_NONE = 'none';

/** Корзины удержания `bracket` (дни от когорты, включительно). */
export const RETENTION_BRACKETS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 7],
  [8, 14],
  [15, 30],
  [31, 60],
  [61, 90],
];

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDaysIso = (day: string, n: number) => new Date(dayMs(day) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / 86_400_000);

/** Тот же отрезок непосредственно перед диапазоном. */
export function previousRange(range: AnalyticsRange): AnalyticsRange {
  const n = daysBetween(range.from, range.to) + 1;
  return { from: addDaysIso(range.from, -n), to: addDaysIso(range.to, -n) };
}

/** Начало суток `day` в поясе платформы как timestamptz. */
export const dayStart = (day: string, tz: string) => Prisma.sql`((${day}::date)::timestamp AT TIME ZONE ${tz})`;

/** Интервал периода — только из белого списка (в SQL уходит литералом). */
export const intervalLiteral = (i: 'day' | 'week' | 'month') => Prisma.raw(`'${i === 'week' ? 'week' : i === 'month' ? 'month' : 'day'}'`);

/** Платформы из фильтров `platforms` ∩ `sources` (web → web, mobile → ios/android, server → server). */
export function platformsOf(f: AnalyticsFilters): string[] | null {
  const bySource = f.sources?.length
    ? f.sources.flatMap((s) => (s === 'web' ? ['web'] : s === 'mobile' ? ['ios', 'android'] : ['server']))
    : null;
  if (f.platforms?.length && bySource) return f.platforms.filter((p) => bySource.includes(p));
  return f.platforms?.length ? [...f.platforms] : bySource;
}

type Table = 'event' | 'actor' | 'session' | 'raw';

/**
 * Условия фильтров для таблицы. Имена колонок — константы (alias + имя), значения —
 * параметры. `raw` — сырьё `analytics.events` (`is_internal`), прочие — роллапы (`internal`).
 */
export function filterConditions(
  f: AnalyticsFilters,
  excludeInternal: boolean,
  table: Table,
  alias: string,
  opts: { ignoreEventKeys?: boolean } = {},
): Prisma.Sql[] {
  const c = (name: string) => Prisma.raw(`${alias}.${name}`);
  const out: Prisma.Sql[] = [];
  if (f.services?.length && table !== 'session') out.push(Prisma.sql`${c('service')} = ANY(${f.services}::text[])`);
  if (f.eventKeys?.length && !opts.ignoreEventKeys && (table === 'event' || table === 'raw')) {
    out.push(Prisma.sql`${c('event_key')} = ANY(${f.eventKeys}::text[])`);
  }
  const platforms = platformsOf(f);
  if (platforms) out.push(platforms.length ? Prisma.sql`${c('platform')} = ANY(${platforms}::text[])` : Prisma.sql`false`);
  if (f.planKeys?.length && table !== 'session') {
    const named = f.planKeys.filter((p) => p !== PLAN_NONE);
    const none = f.planKeys.includes(PLAN_NONE);
    out.push(
      none
        ? Prisma.sql`(${c('plan_key')} IS NULL OR ${c('plan_key')} = ANY(${named}::text[]))`
        : Prisma.sql`${c('plan_key')} = ANY(${named}::text[])`,
    );
  }
  if (f.context === 'personal') out.push(Prisma.sql`${c('workspace_id')} IS NULL`);
  if (f.context === 'workspace') out.push(Prisma.sql`${c('workspace_id')} IS NOT NULL`);
  if (f.workspaceId) out.push(Prisma.sql`${c('workspace_id')} = ${f.workspaceId}::uuid`);
  if (excludeInternal) out.push(table === 'raw' ? Prisma.sql`${c('is_internal')} = false` : Prisma.sql`${c('internal')} = false`);
  return out;
}

export const and = (conds: Prisma.Sql[]) => (conds.length ? Prisma.join(conds, ' AND ') : Prisma.sql`true`);

/** Субъект сырья с ретро-склейкой анонима (неоспоренная связь). Требует LEFT JOIN `l`. */
export const rawPersonSubject = Prisma.sql`COALESCE(e.user_id, CASE WHEN l.contested = false THEN l.user_id END, e.anonymous_id)`;
export const rawLinkJoin = Prisma.sql`LEFT JOIN analytics_identity_links l ON e.user_id IS NULL AND l.anonymous_id = e.anonymous_id`;

/** k-анонимность ячейки. */
export const isMasked = (people: number | null | undefined, k: number) => people !== null && people !== undefined && people < k;
