import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ANALYTICS_ERROR_CODES,
  ANALYTICS_LIMITS,
  ANALYTICS_PRODUCT_AREAS,
  ANALYTICS_QUALIFYING_KEYS,
  analyticsEnumPropsOf,
  analyticsRangeDays,
  isAnalyticsEventKey,
  type AnalyticsAdoptionResultDto,
  type AnalyticsAreaKey,
  type AnalyticsBreakdownResultDto,
  type AnalyticsFunnelResultDto,
  type AnalyticsJourneysResultDto,
  type AnalyticsLifecycleResultDto,
  type AnalyticsQueryInput,
  type AnalyticsQueryMetaDto,
  type AnalyticsQueryResponseDto,
  type AnalyticsQueryResultDto,
  type AnalyticsRange,
  type AnalyticsRetentionResultDto,
  type AnalyticsSeriesDto,
  type AnalyticsTrendResultDto,
} from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { badRequest } from '../../shared/errors/api-error';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { ANALYTICS_JOBS, ANALYTICS_QUEUE, ANALYTICS_REDIS, analyticsEnv } from './analytics.constants';
import { dayInZone } from './analytics.enrich';
import {
  PLAN_NONE,
  RETENTION_BRACKETS,
  addDaysIso,
  and,
  dayStart,
  daysBetween,
  filterConditions,
  intervalLiteral,
  isMasked,
  previousRange,
  rawLinkJoin,
  rawPersonSubject,
} from './analytics.metrics';
import { AnalyticsPartitions } from './analytics.partitions';
import { AnalyticsReadDb } from './analytics.read-db';

type Q<T extends AnalyticsQueryInput['type']> = Extract<AnalyticsQueryInput, { type: T }>;

interface Ctx {
  tz: string;
  k: number;
  today: string;
  timeoutMs: number;
}

interface Cell {
  period: string;
  key: string;
  value: number | null;
  users: number | null;
}

const raw = (s: string) => Prisma.raw(s);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null, digits = 4) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Периоды диапазона (начала дня/ISO-недели/месяца) — ось графика без дыр. */
export function periodsOf(range: AnalyticsRange, interval: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  if (interval === 'day') {
    for (let d = range.from; d <= range.to; d = addDaysIso(d, 1)) out.push(d);
    return out;
  }
  if (interval === 'week') {
    const dow = new Date(`${range.from}T00:00:00Z`).getUTCDay();
    let d = addDaysIso(range.from, -((dow + 6) % 7));
    for (; d <= range.to; d = addDaysIso(d, 7)) out.push(d);
    return out;
  }
  let [y, m] = range.from.split('-').map(Number);
  for (;;) {
    const d = `${y}-${String(m).padStart(2, '0')}-01`;
    if (d > range.to) break;
    out.push(d);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * Исполнитель языка запросов Кабинета. ЕДИНСТВЕННЫЙ путь чтения аналитики: он сам
 * дописывает фильтры, исключение внутренних аккаунтов, k-анонимность и
 * `statement_timeout`; сырой SQL из контроллеров запрещён (инвариант движка).
 * trend/breakdown/adoption/lifecycle/retention — по роллапам; воронка, переходы и
 * метрики по конкретному событию — по сырью с таймаутом. Воронка длиннее 90 дней
 * считается фоновым джобом, результат — в кэше (час с сегодняшним днём, иначе сутки).
 */
@Injectable()
export class AnalyticsQueryService implements OnModuleInit {
  constructor(
    private readonly read: AnalyticsReadDb,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    private readonly registry: JobsRegistry,
    private readonly partitions: AnalyticsPartitions,
  ) {}

  onModuleInit(): void {
    this.registry.register(ANALYTICS_JOBS.reportRun, (payload) => this.runReportJob(payload), {
      queue: ANALYTICS_QUEUE,
      maxAttempts: 3,
      leaseMs: 10 * 60_000,
      queueConcurrency: 2,
    });
  }

  // ============================================================
  // Вход
  // ============================================================

  async run(q: AnalyticsQueryInput, opts: { background?: boolean } = {}): Promise<AnalyticsQueryResponseDto> {
    const env = analyticsEnv();
    const ctx: Ctx = {
      tz: env.timezone,
      k: env.kAnon,
      today: dayInZone(new Date(), env.timezone),
      timeoutMs: opts.background ? 120_000 : env.queryTimeoutMs,
    };
    const days = analyticsRangeDays(q.range);
    const hash = createHash('sha256').update(JSON.stringify({ v: 1, q, tz: ctx.tz, k: ctx.k })).digest('hex').slice(0, 40);

    const hit = await this.redis.cache.getJson<AnalyticsQueryResultDto>(ANALYTICS_REDIS.query(hash)).catch(() => null);
    if (hit) return { status: 'ready', result: hit, meta: await this.meta(q, ctx, true) };

    if (q.type === 'journeys' && days > ANALYTICS_LIMITS.journeysMaxDays) {
      throw badRequest('analytics.range_too_long', { max: ANALYTICS_LIMITS.journeysMaxDays }, { code: ANALYTICS_ERROR_CODES.rangeTooLong });
    }
    if (q.type === 'funnel') this.assertStepFilters(q);
    if (q.type === 'funnel' && days > ANALYTICS_LIMITS.funnelInteractiveMaxDays && !opts.background) {
      await this.redis.setJson(ANALYTICS_REDIS.reportJob(hash), q, 3600);
      await this.jobs.enqueue(null, { type: ANALYTICS_JOBS.reportRun, payload: { id: hash }, uniqueKey: `report:${hash}` });
      return { status: 'pending', jobId: hash, meta: await this.meta(q, ctx, false) };
    }

    const result = await this.execute(q, ctx);
    // Диапазон с сегодняшним днём живёт минуту — данные ещё прибывают. Результат
    // ФОНОВОГО расчёта (минуты работы БД) — час: минутный кэш заставил бы плитку
    // ставить тот же джоб заново на каждом поллинге, пока дашборд открыт.
    const ttl = q.range.to >= ctx.today ? (opts.background ? 3600 : 60) : 86_400;
    await this.redis.cache.setJson(ANALYTICS_REDIS.query(hash), result, ttl).catch(() => undefined);
    return { status: 'ready', result, meta: await this.meta(q, ctx, false) };
  }

  private async runReportJob(payload: Record<string, unknown>): Promise<void> {
    const id = typeof payload.id === 'string' && /^[0-9a-f]{40}$/.test(payload.id) ? payload.id : null;
    if (!id) throw new JobDiscardError('analytics.report.run: invalid id');
    const q = await this.redis.getJson<AnalyticsQueryInput>(ANALYTICS_REDIS.reportJob(id));
    if (!q) throw new JobDiscardError('analytics.report.run: query expired');
    await this.run(q, { background: true });
  }

  private async meta(q: AnalyticsQueryInput, ctx: Ctx, cached: boolean): Promise<AnalyticsQueryMetaDto> {
    const [rollupAt, firstEventAt] = await Promise.all([
      this.redis.get(ANALYTICS_REDIS.rollupAt).catch(() => null),
      this.firstEventAt().catch(() => null),
    ]);
    return {
      type: q.type,
      range: q.range,
      previousRange: q.compare ? previousRange(q.range) : null,
      timezone: ctx.tz,
      computedAt: new Date().toISOString(),
      rollupAt,
      firstEventAt,
      cached,
      kAnon: ctx.k,
    };
  }

  /** Первое событие в хранилище — для честного пустого состояния («сбор начался …»). */
  async firstEventAt(): Promise<string | null> {
    const cached = await this.redis.get(ANALYTICS_REDIS.firstEvent);
    if (cached) return cached;
    for (const p of await this.partitions.list()) {
      const rows = await this.read.query<{ first: Date | null }>(Prisma.sql`SELECT min(ts) AS first FROM ${raw(`analytics.${p.name}`)}`);
      const first = rows[0]?.first;
      if (first) {
        const iso = new Date(first).toISOString();
        await this.redis.set(ANALYTICS_REDIS.firstEvent, iso);
        return iso;
      }
    }
    return null;
  }

  private assertStepFilters(q: Q<'funnel'>): void {
    for (const step of q.steps) {
      if (!step.where) continue;
      // Свойство — часть схемы ОДНОГО события: у шага «любое из» фильтра нет
      const allowed = !step.orEventKeys?.length && isAnalyticsEventKey(step.eventKey) ? analyticsEnumPropsOf(step.eventKey) : [];
      const prop = allowed.find((p) => p.prop === step.where!.prop);
      if (!prop || !prop.values.includes(step.where.value)) {
        throw badRequest('analytics.invalid_filter', { prop: step.where.prop }, { code: 'analytics.invalid_filter' });
      }
    }
  }

  async execute(q: AnalyticsQueryInput, ctx: Ctx): Promise<AnalyticsQueryResultDto> {
    switch (q.type) {
      case 'trend':
        return this.trend(q, ctx);
      case 'funnel':
        return this.funnel(q, ctx);
      case 'retention':
        return this.retention(q, ctx);
      case 'breakdown':
        return this.breakdown(q, ctx);
      case 'lifecycle':
        return this.lifecycle(q, ctx);
      case 'adoption':
        return this.adoption(q, ctx);
      case 'journeys':
        return this.journeys(q, ctx);
    }
  }

  // ============================================================
  // Тренд
  // ============================================================

  private async trend(q: Q<'trend'>, ctx: Ctx): Promise<AnalyticsTrendResultDto> {
    const cur = await this.trendSeries(q, q.range, ctx);
    const prevRange = q.compare ? previousRange(q.range) : null;
    const prev = prevRange ? await this.trendSeries(q, prevRange, ctx) : null;
    const shift = prevRange ? daysBetween(prevRange.from, q.range.from) : 0;
    return {
      type: 'trend',
      metric: q.metric,
      interval: cur.interval,
      series: cur.series,
      previous: prev ? prev.series.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, period: addDaysIso(p.period, shift) })) })) : null,
      current: cur.current,
      previousValue: prev?.current ?? null,
    };
  }

  private dim(b: Q<'trend'>['breakdown'], alias: string, table: 'actor' | 'event' | 'session' | 'raw'): Prisma.Sql {
    if (!b) return Prisma.sql`'total'`;
    if (table === 'session' && (b === 'service' || b === 'plan')) return Prisma.sql`'total'`;
    if (b === 'service') return raw(`${alias}.service`);
    if (b === 'platform') return raw(`${alias}.platform`);
    if (b === 'plan') return raw(`COALESCE(${alias}.plan_key, '${PLAN_NONE}')`);
    return raw(`COALESCE(${alias}.workspace_id::text, 'personal')`);
  }

  private async trendSeries(q: Q<'trend'>, range: AnalyticsRange, ctx: Ctx): Promise<{ interval: 'day' | 'week' | 'month'; series: AnalyticsSeriesDto[]; current: number | null }> {
    const daily = ['dau', 'wau', 'mau', 'stickiness', 'active_workspaces'].includes(q.metric);
    const interval = daily ? 'day' : q.interval;
    const sessionMetric = q.metric === 'sessions' || q.metric === 'session_p50';
    // У роллапа сессий нет измерений «сервис» и «тариф» (сессия сквозная): такое разбиение
    // равно его отсутствию, а не одной серии «total», спрятанной k-анонимностью
    const breakdown = sessionMetric && (q.breakdown === 'service' || q.breakdown === 'plan') ? undefined : q.breakdown;
    const periods = periodsOf(range, interval);
    const g = intervalLiteral(interval);
    const from = range.from;
    const to = range.to;
    const actorF = and(filterConditions(q.filters, q.excludeInternal, 'actor', 'a'));
    const eventF = filterConditions(q.filters, q.excludeInternal, 'event', 'a', { ignoreEventKeys: !!q.eventKey });
    if (q.eventKey) eventF.push(Prisma.sql`a.event_key = ${q.eventKey}`);
    const rawF = filterConditions(q.filters, q.excludeInternal, 'raw', 'e', { ignoreEventKeys: !!q.eventKey });
    if (q.eventKey) rawF.push(Prisma.sql`e.event_key = ${q.eventKey}`);

    const activeRows = (window: number) =>
      this.read.query<Cell>(Prisma.sql`
        SELECT to_char(d.day::date, 'YYYY-MM-DD') AS period, ${this.dim(breakdown, 'a', 'actor')} AS key,
          count(DISTINCT a.actor_id)::int AS value, count(DISTINCT a.actor_id)::int AS users
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d(day)
        JOIN analytics_rollup_actor_day a ON a.day BETWEEN (d.day::date - ${window - 1}::int) AND d.day::date
        WHERE a.qualifying AND a.actor_kind = 0 AND ${actorF}
        GROUP BY 1, 2`, ctx.timeoutMs);

    let cells: Cell[];
    switch (q.metric) {
      case 'dau':
        cells = await activeRows(1);
        break;
      case 'wau':
        cells = await activeRows(7);
        break;
      case 'mau':
        cells = await activeRows(28);
        break;
      case 'stickiness': {
        const [dau, mau] = await Promise.all([activeRows(1), activeRows(28)]);
        const mauBy = new Map(mau.map((c) => [`${c.period}|${c.key}`, num(c.value) ?? 0]));
        cells = dau.map((c) => {
          const m = mauBy.get(`${c.period}|${c.key}`) ?? 0;
          return { period: c.period, key: c.key, value: m > 0 ? round((num(c.value) ?? 0) / m) : null, users: m };
        });
        break;
      }
      case 'active_workspaces':
        cells = await this.read.query<Cell>(Prisma.sql`
          SELECT to_char(a.day, 'YYYY-MM-DD') AS period, ${this.dim(breakdown, 'a', 'actor')} AS key,
            count(DISTINCT a.workspace_id)::int AS value, count(DISTINCT a.actor_id)::int AS users
          FROM analytics_rollup_actor_day a
          WHERE a.day BETWEEN ${from}::date AND ${to}::date AND a.qualifying AND a.actor_kind = 0
            AND a.workspace_id IS NOT NULL AND ${actorF}
          GROUP BY 1, 2`, ctx.timeoutMs);
        break;
      case 'new_users':
        cells = await this.read.query<Cell>(Prisma.sql`
          SELECT to_char(date_trunc(${g}, f.first_day)::date, 'YYYY-MM-DD') AS period, f.key, count(*)::int AS value, count(*)::int AS users
          FROM (
            SELECT a.actor_id, ${this.dim(breakdown, 'a', 'actor')} AS key, min(a.day) AS first_day
            FROM analytics_rollup_actor_day a
            WHERE a.qualifying AND a.actor_kind = 0 AND a.day <= ${to}::date AND ${actorF}
            GROUP BY a.actor_id, 2
          ) f
          WHERE f.first_day BETWEEN ${from}::date AND ${to}::date
          GROUP BY 1, 2`, ctx.timeoutMs);
        break;
      case 'events':
        cells = await this.read.query<Cell>(Prisma.sql`
          SELECT to_char(date_trunc(${g}, a.day)::date, 'YYYY-MM-DD') AS period, ${this.dim(breakdown, 'a', 'event')} AS key,
            sum(a.count)::int AS value, max(a.users)::int AS users
          FROM analytics_rollup_event_day a
          WHERE a.day BETWEEN ${from}::date AND ${to}::date AND ${and(eventF)}
          GROUP BY 1, 2`, ctx.timeoutMs);
        break;
      case 'event_users':
        cells = await this.read.query<Cell>(Prisma.sql`
          SELECT to_char(date_trunc(${g}, (e.ts AT TIME ZONE ${ctx.tz}))::date, 'YYYY-MM-DD') AS period, ${this.dim(breakdown, 'e', 'raw')} AS key,
            count(DISTINCT ${rawPersonSubject})::int AS value, count(DISTINCT ${rawPersonSubject})::int AS users
          FROM analytics.events e ${rawLinkJoin}
          WHERE e.ts >= ${dayStart(from, ctx.tz)} AND e.ts < ${dayStart(addDaysIso(to, 1), ctx.tz)} AND ${and(rawF)}
          GROUP BY 1, 2`, ctx.timeoutMs);
        break;
      case 'sessions':
      case 'session_p50': {
        const sessionF = and(filterConditions(q.filters, q.excludeInternal, 'session', 'a'));
        const value = q.metric === 'sessions' ? Prisma.sql`sum(a.sessions)::int` : Prisma.sql`round(percentile_cont(0.5) WITHIN GROUP (ORDER BY a.duration_p50_s))::int`;
        cells = await this.read.query<Cell>(Prisma.sql`
          SELECT to_char(date_trunc(${g}, a.day)::date, 'YYYY-MM-DD') AS period, ${this.dim(breakdown, 'a', 'session')} AS key,
            ${value} AS value, NULL::int AS users
          FROM analytics_rollup_session_day a
          WHERE a.day BETWEEN ${from}::date AND ${to}::date AND ${sessionF}
          GROUP BY 1, 2`, ctx.timeoutMs);
        // k-анонимность «сессии × организация»: людей в роллапе сессий нет — счёт берётся
        // из роллапа субъектов за тот же период (иначе каждая ячейка считалась бы < K)
        if (breakdown === 'workspace') {
          const people = await this.read.query<{ key: string; users: number }>(Prisma.sql`
            SELECT COALESCE(a.workspace_id::text, 'personal') AS key, count(DISTINCT a.actor_id)::int AS users
            FROM analytics_rollup_actor_day a
            WHERE a.day BETWEEN ${from}::date AND ${to}::date AND a.actor_kind = 0 AND ${actorF}
            GROUP BY 1`, ctx.timeoutMs);
          const peopleByKey = new Map(people.map((p) => [p.key, Number(p.users)]));
          cells = cells.map((c) => ({ ...c, users: peopleByKey.get(c.key) ?? 0 }));
        }
        break;
      }
    }

    const additive = ['events', 'new_users', 'sessions'].includes(q.metric);
    const nullable = q.metric === 'stickiness' || q.metric === 'session_p50';
    const byKey = new Map<string, Map<string, Cell>>();
    for (const c of cells) {
      if (!byKey.has(c.key)) byKey.set(c.key, new Map());
      byKey.get(c.key)!.set(c.period, c);
    }
    const totalOf = (m: Map<string, Cell>) => [...m.values()].reduce((s, c) => s + (num(c.value) ?? 0), 0);
    let keys = [...byKey.keys()].sort((a, b) => totalOf(byKey.get(b)!) - totalOf(byKey.get(a)!));
    if (!breakdown) keys = ['total'];
    const maxSeries = ANALYTICS_LIMITS.maxSeries;
    const top = breakdown && keys.length > maxSeries ? keys.slice(0, maxSeries - 1) : keys;
    const rest = breakdown && keys.length > maxSeries ? keys.slice(maxSeries - 1) : [];
    const maskable = breakdown === 'plan' || breakdown === 'workspace';

    const build = (key: string, cellsOf: (period: string) => Cell | undefined): AnalyticsSeriesDto => {
      const maxUsers = periods.reduce((m, p) => Math.max(m, num(cellsOf(p)?.users) ?? 0), 0);
      // «personal» — не организация, а все личные пространства разом: исключение ТОЛЬКО у
      // разбиения по организации (тариф тоже бывает с ключом `personal` — его ячейка маскируется)
      const aggregateKey = (breakdown === 'workspace' && key === 'personal') || key === 'other';
      const masked = maskable && !aggregateKey && isMasked(maxUsers, ctx.k);
      const points = periods.map((period) => {
        const v = num(cellsOf(period)?.value);
        return masked ? { period, value: null, masked: true } : { period, value: v ?? (nullable ? null : 0) };
      });
      const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
      const total = masked || !vals.length ? null : additive ? vals.reduce((s, v) => s + v, 0) : round(vals.reduce((s, v) => s + v, 0) / vals.length, 2);
      return { key, points, total, ...(masked ? { masked: true } : {}) };
    };

    const series = top.map((key) => build(key, (p) => byKey.get(key)?.get(p)));
    if (rest.length && additive) {
      series.push(
        build('other', (p) => ({
          period: p,
          key: 'other',
          value: rest.reduce((s, k) => s + (num(byKey.get(k)?.get(p)?.value) ?? 0), 0),
          users: null,
        })),
      );
    }
    let current: number | null = null;
    if (!breakdown && series[0]) {
      if (additive) current = series[0].total;
      else {
        const last = [...series[0].points].reverse().find((p) => p.value !== null);
        current = last?.value ?? null;
      }
    }
    return { interval, series, current };
  }

  // ============================================================
  // Воронка (сырьё)
  // ============================================================

  private async funnel(q: Q<'funnel'>, ctx: Ctx): Promise<AnalyticsFunnelResultDto> {
    const cur = await this.funnelCounts(q, q.range, ctx);
    const prev = q.compare ? await this.funnelCounts(q, previousRange(q.range), ctx) : null;
    const counts = cur.total;
    let biggestDropIndex: number | null = null;
    let worst = 0;
    const steps = q.steps.map((s, i) => {
      const n = counts[i] ?? 0;
      const before = i === 0 ? n : (counts[i - 1] ?? 0);
      if (i > 0 && before > 0) {
        const drop = (before - n) / before;
        if (drop > worst) {
          worst = drop;
          biggestDropIndex = i;
        }
      }
      return {
        eventKey: s.eventKey,
        orEventKeys: s.orEventKeys ?? [],
        count: n,
        fromPrevious: i === 0 ? 1 : before > 0 ? round(n / before) : null,
        fromStart: counts[0] ? round(n / counts[0]) : null,
        medianSecondsFromPrevious: i === 0 ? null : (cur.median[i] ?? null),
        previousCount: prev ? (prev.total[i] ?? 0) : null,
      };
    });
    const breakdown = q.breakdown
      ? [...cur.byKey.entries()]
          .map(([key, arr]) => {
            const masked = isMasked(arr[0] ?? 0, ctx.k);
            return { key, counts: q.steps.map((_, i) => (masked ? null : (arr[i] ?? 0))), masked };
          })
          .sort((a, b) => (b.counts[0] ?? -1) - (a.counts[0] ?? -1))
      : null;
    return { type: 'funnel', unit: q.unit, mode: q.mode, windowDays: q.windowDays, steps, biggestDropIndex, breakdown };
  }

  private async funnelCounts(q: Q<'funnel'>, range: AnalyticsRange, ctx: Ctx): Promise<{ total: number[]; median: Array<number | null>; byKey: Map<string, number[]> }> {
    const lo = dayStart(range.from, ctx.tz);
    const hi = dayStart(addDaysIso(range.to, 1), ctx.tz);
    const person = q.unit === 'user';
    const keys = [...new Set(q.steps.flatMap((s) => [s.eventKey, ...(s.orEventKeys ?? [])]))];
    const dimCol = q.breakdown === 'plan' ? 'plan' : q.breakdown === 'platform' ? 'platform' : null;
    const stepCond = (i: number, alias: string) => {
      const s = q.steps[i];
      if (s.orEventKeys?.length) {
        // «Любое из»: первое вхождение ЛЮБОГО события шага (фильтра по свойству у такого шага нет)
        return Prisma.sql`${raw(alias)}.event_key = ANY(${[s.eventKey, ...s.orEventKeys]}::text[])`;
      }
      const where = s.where ? Prisma.sql` AND ${raw(alias)}.props ->> ${s.where.prop} = ${s.where.value}` : Prisma.empty;
      return Prisma.sql`${raw(alias)}.event_key = ${s.eventKey}${where}`;
    };
    const ctes: Prisma.Sql[] = [
      Prisma.sql`base AS (
        SELECT ${person ? rawPersonSubject : Prisma.sql`e.workspace_id`} AS subject, e.event_key, e.ts, e.platform,
          COALESCE(e.plan_key, ${PLAN_NONE}) AS plan, e.props
        FROM analytics.events e ${person ? rawLinkJoin : Prisma.empty}
        WHERE e.ts >= ${lo} AND e.ts < ${hi} + make_interval(days => ${q.windowDays}::int)
          AND e.event_key = ANY(${keys}::text[])
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'raw', 'e', { ignoreEventKeys: true }))}
      )`,
      Prisma.sql`s1 AS (
        SELECT b.subject, min(b.ts) AS t0, min(b.ts) AS t,
          (array_agg(b.platform ORDER BY b.ts))[1] AS platform, (array_agg(b.plan ORDER BY b.ts))[1] AS plan
        FROM base b
        WHERE ${stepCond(0, 'b')} AND b.ts < ${hi} AND b.subject IS NOT NULL
        GROUP BY b.subject
      )`,
    ];
    for (let i = 1; i < q.steps.length; i++) {
      const prevName = raw(`s${i}`);
      const lower = q.mode === 'any' ? Prisma.sql`b.ts >= p.t0` : Prisma.sql`b.ts > p.t`;
      const strict =
        q.mode === 'strict' ? Prisma.sql` AND NOT EXISTS (SELECT 1 FROM base x WHERE x.subject = p.subject AND x.ts > p.t AND x.ts < b.ts)` : Prisma.empty;
      ctes.push(Prisma.sql`${raw(`s${i + 1}`)} AS (
        SELECT p.subject, p.t0, min(b.ts) AS t, p.platform, p.plan
        FROM ${prevName} p
        JOIN base b ON b.subject = p.subject AND ${stepCond(i, 'b')} AND ${lower}
          AND b.ts <= p.t0 + make_interval(days => ${q.windowDays}::int)${strict}
        GROUP BY p.subject, p.t0, p.platform, p.plan
      )`);
    }
    const selects: Prisma.Sql[] = [];
    for (let i = 0; i < q.steps.length; i++) {
      const cur = raw(`s${i + 1}`);
      const dimExpr = dimCol ? raw(`s${i + 1}.${dimCol}`) : Prisma.sql`NULL::text`;
      const group = dimCol ? Prisma.sql`GROUP BY GROUPING SETS ((), (${raw(`s${i + 1}.${dimCol}`)}))` : Prisma.empty;
      if (i === 0) {
        selects.push(Prisma.sql`SELECT 1 AS step, ${dimExpr} AS key, count(*)::int AS n, NULL::float8 AS med FROM s1 ${group}`);
      } else {
        selects.push(Prisma.sql`
          SELECT ${i + 1} AS step, ${dimExpr} AS key, count(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${cur}.t - ${raw(`s${i}`)}.t))::float8 AS med
          FROM ${cur} JOIN ${raw(`s${i}`)} ON ${raw(`s${i}`)}.subject = ${cur}.subject ${group}`);
      }
    }
    const rows = await this.read.query<{ step: number; key: string | null; n: number; med: number | null }>(
      Prisma.sql`WITH ${Prisma.join(ctes, ', ')} ${Prisma.join(selects, ' UNION ALL ')}`,
      ctx.timeoutMs,
    );
    const total = q.steps.map(() => 0);
    const median: Array<number | null> = q.steps.map(() => null);
    const byKey = new Map<string, number[]>();
    for (const r of rows) {
      const i = Number(r.step) - 1;
      if (r.key === null) {
        total[i] = Number(r.n);
        median[i] = r.med === null ? null : Math.round(Number(r.med));
      } else {
        if (!byKey.has(r.key)) byKey.set(r.key, q.steps.map(() => 0));
        byKey.get(r.key)![i] = Number(r.n);
      }
    }
    return { total, median, byKey };
  }

  // ============================================================
  // Удержание
  // ============================================================

  private async retention(q: Q<'retention'>, ctx: Ctx): Promise<AnalyticsRetentionResultDto> {
    const rangeDays = analyticsRangeDays(q.range);
    const grain = rangeDays > 35 ? 'week' : 'day';
    const horizon = q.mode === 'bracket' ? Math.min(90, RETENTION_BRACKETS.filter(([lo]) => lo <= q.days).at(-1)?.[1] ?? 90) : q.days;
    const columns =
      q.mode === 'bracket'
        ? RETENTION_BRACKETS.filter(([lo]) => lo <= q.days).map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}-${hi}`))
        : Array.from({ length: horizon + 1 }, (_, i) => String(i));
    const upper = addDaysIso(q.range.to, horizon);

    // act(actor, day) и first(actor, d0): роллап (по умолчанию) либо сырьё (указанные события)
    let act: Prisma.Sql;
    let first: Prisma.Sql;
    if (!q.startEvent && !q.returnEvent) {
      const actor = q.unit === 'workspace' ? raw('a.workspace_id') : raw('a.actor_id');
      const extra = q.unit === 'workspace' ? Prisma.sql`a.workspace_id IS NOT NULL` : Prisma.sql`a.actor_kind = 0`;
      act = Prisma.sql`act AS (
        SELECT DISTINCT ${actor} AS actor, a.day FROM analytics_rollup_actor_day a
        WHERE a.qualifying AND ${extra} AND a.day <= ${upper}::date
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'actor', 'a'))}
      )`;
      first = Prisma.sql`origin AS (SELECT actor, min(day) AS d0 FROM act GROUP BY actor)`;
    } else {
      const subject = q.unit === 'workspace' ? Prisma.sql`e.workspace_id` : rawPersonSubject;
      const qualifying = ANALYTICS_QUALIFYING_KEYS as string[];
      act = Prisma.sql`base AS (
        SELECT ${subject} AS actor, (e.ts AT TIME ZONE ${ctx.tz})::date AS day, e.event_key
        FROM analytics.events e ${q.unit === 'workspace' ? Prisma.empty : rawLinkJoin}
        WHERE e.ts >= ${dayStart(q.range.from, ctx.tz)} AND e.ts < ${dayStart(addDaysIso(upper, 1), ctx.tz)}
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'raw', 'e', { ignoreEventKeys: true }))}
      ), act AS (
        SELECT DISTINCT actor, day FROM base
        WHERE actor IS NOT NULL AND ${q.returnEvent ? Prisma.sql`event_key = ${q.returnEvent}` : Prisma.sql`event_key = ANY(${qualifying}::text[])`}
      )`;
      first = Prisma.sql`origin AS (
        SELECT actor, min(day) AS d0 FROM base
        WHERE actor IS NOT NULL AND ${q.startEvent ? Prisma.sql`event_key = ${q.startEvent}` : Prisma.sql`event_key = ANY(${qualifying}::text[])`}
        GROUP BY actor
      )`;
    }
    const g = intervalLiteral(grain);
    const cohortExpr = Prisma.sql`to_char(date_trunc(${g}, f.d0)::date, 'YYYY-MM-DD')`;
    const inRange = Prisma.sql`f.d0 BETWEEN ${q.range.from}::date AND ${q.range.to}::date`;

    const sizes = await this.read.query<{ cohort: string; size: number }>(
      Prisma.sql`WITH ${act}, ${first} SELECT ${cohortExpr} AS cohort, count(*)::int AS size FROM origin f WHERE ${inRange} GROUP BY 1 ORDER BY 1`,
      ctx.timeoutMs,
    );
    let cellsSql: Prisma.Sql;
    if (q.mode === 'n_day') {
      cellsSql = Prisma.sql`SELECT ${cohortExpr} AS cohort, (a.day - f.d0) AS col, count(DISTINCT a.actor)::int AS n
        FROM origin f JOIN act a ON a.actor = f.actor
        WHERE ${inRange} AND a.day - f.d0 BETWEEN 0 AND ${horizon} GROUP BY 1, 2`;
    } else if (q.mode === 'unbounded') {
      cellsSql = Prisma.sql`SELECT cohort, mx AS col, count(*)::int AS n FROM (
          SELECT f.actor, ${cohortExpr} AS cohort, max(a.day - f.d0) AS mx
          FROM origin f JOIN act a ON a.actor = f.actor
          WHERE ${inRange} AND a.day - f.d0 BETWEEN 0 AND ${horizon} GROUP BY f.actor, 2
        ) x GROUP BY cohort, mx`;
    } else {
      const cases = Prisma.join(
        RETENTION_BRACKETS.map(([lo, hi], i) => Prisma.sql`WHEN a.day - f.d0 BETWEEN ${lo} AND ${hi} THEN ${i}`),
        ' ',
      );
      cellsSql = Prisma.sql`SELECT ${cohortExpr} AS cohort, CASE ${cases} END AS col, count(DISTINCT a.actor)::int AS n
        FROM origin f JOIN act a ON a.actor = f.actor
        WHERE ${inRange} AND a.day - f.d0 BETWEEN 1 AND 90 GROUP BY 1, 2`;
    }
    const cells = await this.read.query<{ cohort: string; col: number | null; n: number }>(
      Prisma.sql`WITH ${act}, ${first} ${cellsSql}`,
      ctx.timeoutMs,
    );

    const byCohort = new Map<string, Map<number, number>>();
    for (const c of cells) {
      if (c.col === null) continue;
      if (!byCohort.has(c.cohort)) byCohort.set(c.cohort, new Map());
      byCohort.get(c.cohort)!.set(Number(c.col), Number(c.n));
    }
    const colStart = (j: number) => (q.mode === 'bracket' ? RETENTION_BRACKETS[j][0] : j);
    const sums = columns.map(() => ({ n: 0, size: 0 }));
    let totalSize = 0;
    const cohorts = sizes.map((s) => {
      const size = Number(s.size);
      totalSize += size;
      const m = byCohort.get(s.cohort) ?? new Map<number, number>();
      const masked = isMasked(size, ctx.k);
      const values = columns.map((_, j) => {
        // Ячейка ещё не наступила: когорта + N > сегодня
        if (addDaysIso(s.cohort, colStart(j)) > ctx.today) return null;
        let n: number;
        if (q.mode === 'unbounded') {
          n = 0;
          for (const [mx, count] of m) if (mx >= j) n += count;
        } else {
          n = m.get(j) ?? 0;
        }
        sums[j].n += n;
        sums[j].size += size;
        return masked || size === 0 ? null : round(n / size);
      });
      return { cohort: s.cohort, size: masked ? null : size, masked, values };
    });
    const curve = isMasked(totalSize, ctx.k) ? columns.map(() => null) : sums.map((s) => (s.size ? round(s.n / s.size) : null));
    return { type: 'retention', mode: q.mode, unit: q.unit, columns, curve, cohorts };
  }

  // ============================================================
  // Разбиение
  // ============================================================

  private breakdownDim(by: Q<'breakdown'>['by'], alias: string): Prisma.Sql {
    if (by === 'service') return raw(`${alias}.service`);
    if (by === 'platform') return raw(`${alias}.platform`);
    if (by === 'plan') return raw(`COALESCE(${alias}.plan_key, '${PLAN_NONE}')`);
    if (by === 'workspace') return raw(`COALESCE(${alias}.workspace_id::text, 'personal')`);
    return raw(`${alias}.event_key`);
  }

  private async breakdownRows(q: Q<'breakdown'>, range: AnalyticsRange, ctx: Ctx): Promise<Array<{ key: string; events: number; users: number | null; workspaces: number | null }>> {
    const from = range.from;
    const to = range.to;
    const rawWindow = Prisma.sql`e.ts >= ${dayStart(from, ctx.tz)} AND e.ts < ${dayStart(addDaysIso(to, 1), ctx.tz)}`;
    if (q.by === 'denied_key') {
      return this.read.query(Prisma.sql`
        SELECT e.props ->> 'key' AS key, count(*)::int AS events,
          count(DISTINCT COALESCE(e.user_id, e.anonymous_id))::int AS users, count(DISTINCT e.workspace_id)::int AS workspaces
        FROM analytics.events e
        WHERE e.event_key = 'entitlements.access.denied' AND ${rawWindow}
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'raw', 'e', { ignoreEventKeys: true }))}
        GROUP BY 1`, ctx.timeoutMs);
    }
    if (q.metric === 'events') {
      const f = filterConditions(q.filters, q.excludeInternal, 'event', 'a', { ignoreEventKeys: !!q.eventKey });
      if (q.eventKey) f.push(Prisma.sql`a.event_key = ${q.eventKey}`);
      return this.read.query(Prisma.sql`
        SELECT ${this.breakdownDim(q.by, 'a')} AS key, sum(a.count)::int AS events, max(a.users)::int AS users, NULL::int AS workspaces
        FROM analytics_rollup_event_day a
        WHERE a.day BETWEEN ${from}::date AND ${to}::date AND ${and(f)}
        GROUP BY 1`, ctx.timeoutMs);
    }
    if (q.by === 'event' || q.eventKey) {
      const f = filterConditions(q.filters, q.excludeInternal, 'raw', 'e', { ignoreEventKeys: !!q.eventKey });
      if (q.eventKey) f.push(Prisma.sql`e.event_key = ${q.eventKey}`);
      return this.read.query(Prisma.sql`
        SELECT ${this.breakdownDim(q.by, 'e')} AS key, count(*)::int AS events,
          count(DISTINCT COALESCE(e.user_id, e.anonymous_id))::int AS users, count(DISTINCT e.workspace_id)::int AS workspaces
        FROM analytics.events e
        WHERE ${rawWindow} AND ${and(f)}
        GROUP BY 1`, ctx.timeoutMs);
    }
    return this.read.query(Prisma.sql`
      SELECT ${this.breakdownDim(q.by, 'a')} AS key, sum(a.events)::int AS events,
        count(DISTINCT a.actor_id) FILTER (WHERE a.actor_kind = 0)::int AS users, count(DISTINCT a.workspace_id)::int AS workspaces
      FROM analytics_rollup_actor_day a
      WHERE a.day BETWEEN ${from}::date AND ${to}::date AND ${and(filterConditions(q.filters, q.excludeInternal, 'actor', 'a'))}
      GROUP BY 1`, ctx.timeoutMs);
  }

  private async activeWorkspacesBy(q: Q<'breakdown'>, range: AnalyticsRange, ctx: Ctx): Promise<Map<string, number>> {
    const perPlan = q.by === 'plan';
    const rows = await this.read.query<{ key: string; n: number }>(Prisma.sql`
      SELECT ${perPlan ? raw(`COALESCE(a.plan_key, '${PLAN_NONE}')`) : Prisma.sql`'total'`} AS key, count(DISTINCT a.workspace_id)::int AS n
      FROM analytics_rollup_actor_day a
      WHERE a.day BETWEEN ${range.from}::date AND ${range.to}::date AND a.qualifying AND a.actor_kind = 0
        AND a.workspace_id IS NOT NULL AND ${and(filterConditions(q.filters, q.excludeInternal, 'actor', 'a'))}
      GROUP BY 1`, ctx.timeoutMs);
    return new Map(rows.map((r) => [r.key, Number(r.n)]));
  }

  private async breakdown(q: Q<'breakdown'>, ctx: Ctx): Promise<AnalyticsBreakdownResultDto> {
    const valueOf = async (range: AnalyticsRange) => {
      const rows = await this.breakdownRows(q, range, ctx);
      const active = q.perActiveWorkspace ? await this.activeWorkspacesBy(q, range, ctx) : null;
      const maskable = q.by === 'plan' || q.by === 'workspace';
      return rows.map((r) => {
        const metric = q.metric === 'events' ? Number(r.events) : q.metric === 'users' ? num(r.users) : num(r.workspaces);
        const denominator = active ? (active.get(q.by === 'plan' ? r.key : 'total') ?? 0) : null;
        const value = active ? (denominator ? round((metric ?? 0) / denominator, 2) : null) : metric;
        const aggregateKey = q.by === 'workspace' && r.key === 'personal';
        const masked = maskable && !aggregateKey && isMasked(num(r.users), ctx.k);
        return { key: r.key ?? 'other', value: masked ? null : value, masked };
      });
    };
    const cur = (await valueOf(q.range)).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    const prev = q.compare ? new Map((await valueOf(previousRange(q.range))).map((r) => [r.key, r.value])) : null;
    const top = cur.slice(0, q.limit);
    const tail = cur.slice(q.limit);
    const additive = q.metric === 'events' && !q.perActiveWorkspace;
    return {
      type: 'breakdown',
      by: q.by,
      metric: q.metric,
      perActiveWorkspace: q.perActiveWorkspace,
      rows: top.map((r) => ({ ...r, previous: prev ? (prev.get(r.key) ?? null) : null })),
      other: additive && tail.length ? tail.reduce((s, r) => s + (r.value ?? 0), 0) : null,
    };
  }

  // ============================================================
  // Жизненный цикл
  // ============================================================

  private async lifecycle(q: Q<'lifecycle'>, ctx: Ctx): Promise<AnalyticsLifecycleResultDto> {
    const g = intervalLiteral(q.interval);
    const step = raw(`interval '1 ${q.interval}'`);
    const actor = q.unit === 'workspace' ? raw('a.workspace_id') : raw('a.actor_id');
    const extra = q.unit === 'workspace' ? Prisma.sql`a.workspace_id IS NOT NULL` : Prisma.sql`a.actor_kind = 0`;
    const cte = Prisma.sql`
      act AS (
        SELECT DISTINCT ${actor} AS actor, date_trunc(${g}, a.day)::date AS p
        FROM analytics_rollup_actor_day a
        WHERE a.qualifying AND ${extra} AND a.day <= ${q.range.to}::date
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'actor', 'a'))}
      ),
      firsts AS (SELECT actor, min(p) AS fp FROM act GROUP BY actor),
      periods AS (
        SELECT gs::date AS p FROM generate_series(date_trunc(${g}, ${q.range.from}::date), date_trunc(${g}, ${q.range.to}::date), ${step}) gs
      )`;
    const [active, dormant] = await Promise.all([
      this.read.query<{ p: string; new: number; current: number; resurrected: number }>(Prisma.sql`
        WITH ${cte}
        SELECT to_char(periods.p, 'YYYY-MM-DD') AS p,
          count(*) FILTER (WHERE f.fp = periods.p)::int AS new,
          count(*) FILTER (WHERE f.fp < periods.p AND prev.actor IS NOT NULL)::int AS current,
          count(*) FILTER (WHERE f.fp < periods.p AND prev.actor IS NULL)::int AS resurrected
        FROM periods
        JOIN act a ON a.p = periods.p
        JOIN firsts f ON f.actor = a.actor
        LEFT JOIN act prev ON prev.actor = a.actor AND prev.p = (periods.p - ${step})::date
        GROUP BY periods.p`, ctx.timeoutMs),
      this.read.query<{ p: string; dormant: number }>(Prisma.sql`
        WITH ${cte}
        SELECT to_char(periods.p, 'YYYY-MM-DD') AS p, count(*)::int AS dormant
        FROM periods
        JOIN act prev ON prev.p = (periods.p - ${step})::date
        LEFT JOIN act cur ON cur.actor = prev.actor AND cur.p = periods.p
        WHERE cur.actor IS NULL
        GROUP BY periods.p`, ctx.timeoutMs),
    ]);
    const a = new Map(active.map((r) => [r.p, r]));
    const d = new Map(dormant.map((r) => [r.p, Number(r.dormant)]));
    return {
      type: 'lifecycle',
      interval: q.interval,
      unit: q.unit,
      buckets: periodsOf(q.range, q.interval).map((p) => ({
        period: p,
        new: Number(a.get(p)?.new ?? 0),
        current: Number(a.get(p)?.current ?? 0),
        resurrected: Number(a.get(p)?.resurrected ?? 0),
        dormant: d.get(p) ?? 0,
      })),
    };
  }

  // ============================================================
  // Adoption сервисов
  // ============================================================

  private async adoptionRows(q: Q<'adoption'>, range: AnalyticsRange, ctx: Ctx) {
    const actor = q.unit === 'workspace' ? raw('a.workspace_id') : raw('a.actor_id');
    const extra = q.unit === 'workspace' ? Prisma.sql`a.workspace_id IS NOT NULL` : Prisma.sql`a.actor_kind = 0`;
    const products = ANALYTICS_PRODUCT_AREAS as string[];
    const planParts = q.byPlan
      ? Prisma.sql`
        UNION ALL SELECT 'plan_total', plan, NULL, count(DISTINCT actor)::int, NULL::float8 FROM src GROUP BY plan
        UNION ALL SELECT 'plan_service', plan, service, count(DISTINCT actor)::int, NULL::float8 FROM src WHERE service = ANY(${products}::text[]) GROUP BY plan, service`
      : Prisma.empty;
    return this.read.query<{ kind: string; plan: string | null; service: string | null; active: number; median: number | null }>(Prisma.sql`
      WITH src AS (
        SELECT ${actor} AS actor, a.service, a.day, COALESCE(a.plan_key, ${PLAN_NONE}) AS plan
        FROM analytics_rollup_actor_day a
        WHERE a.day BETWEEN ${range.from}::date AND ${range.to}::date AND a.qualifying AND ${extra}
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'actor', 'a'))}
      )
      SELECT 'total' AS kind, NULL::text AS plan, NULL::text AS service, count(DISTINCT actor)::int AS active, NULL::float8 AS median FROM src
      UNION ALL
      SELECT 'service', NULL, service, count(DISTINCT actor)::int, percentile_cont(0.5) WITHIN GROUP (ORDER BY d)::float8
      FROM (SELECT service, actor, count(DISTINCT day) AS d FROM src WHERE service = ANY(${products}::text[]) GROUP BY service, actor) x
      GROUP BY service
      ${planParts}`, ctx.timeoutMs);
  }

  private async adoption(q: Q<'adoption'>, ctx: Ctx): Promise<AnalyticsAdoptionResultDto> {
    const rows = await this.adoptionRows(q, q.range, ctx);
    const prevRows = q.compare ? await this.adoptionRows({ ...q, byPlan: false }, previousRange(q.range), ctx) : null;
    const total = Number(rows.find((r) => r.kind === 'total')?.active ?? 0);
    const prevTotal = Number(prevRows?.find((r) => r.kind === 'total')?.active ?? 0);
    const prevShare = new Map((prevRows ?? []).filter((r) => r.kind === 'service').map((r) => [r.service, prevTotal ? Number(r.active) / prevTotal : null]));
    const services = rows
      .filter((r) => r.kind === 'service')
      .map((r) => ({
        service: r.service as AnalyticsAreaKey,
        active: Number(r.active),
        share: total ? round(Number(r.active) / total) : null,
        previousShare: prevRows ? round(prevShare.get(r.service) ?? 0) : null,
        medianDays: r.median === null ? null : round(Number(r.median), 1),
        masked: false,
      }))
      .sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
    let byPlan: AnalyticsAdoptionResultDto['byPlan'] = null;
    if (q.byPlan) {
      byPlan = rows
        .filter((r) => r.kind === 'plan_total')
        .map((p) => {
          const planTotal = Number(p.active);
          const masked = isMasked(planTotal, ctx.k);
          return {
            planKey: p.plan ?? PLAN_NONE,
            activeTotal: masked ? null : planTotal,
            masked,
            services: rows
              .filter((r) => r.kind === 'plan_service' && r.plan === p.plan)
              .map((r) => ({
                service: r.service as AnalyticsAreaKey,
                active: masked ? null : Number(r.active),
                share: masked || !planTotal ? null : round(Number(r.active) / planTotal),
                previousShare: null,
                medianDays: null,
                masked,
              })),
          };
        })
        .sort((a, b) => (b.activeTotal ?? -1) - (a.activeTotal ?? -1));
    }
    return { type: 'adoption', unit: q.unit, activeTotal: total, services, byPlan };
  }

  // ============================================================
  // Переходы между сервисами (сырьё, ≤ 90 дней)
  // ============================================================

  private async journeys(q: Q<'journeys'>, ctx: Ctx): Promise<AnalyticsJourneysResultDto> {
    const rows = await this.read.query<{ from: string; to: string; count: number; users: number }>(Prisma.sql`
      SELECT t.prev AS "from", t.service AS "to", count(*)::int AS count, count(DISTINCT t.subject)::int AS users
      FROM (
        SELECT e.service, COALESCE(e.user_id, e.anonymous_id) AS subject,
          lag(e.service) OVER (PARTITION BY e.session_id ORDER BY e.ts) AS prev
        FROM analytics.events e
        WHERE e.event_key = 'navigation.page.viewed' AND e.session_id IS NOT NULL
          AND e.ts >= ${dayStart(q.range.from, ctx.tz)} AND e.ts < ${dayStart(addDaysIso(q.range.to, 1), ctx.tz)}
          AND ${and(filterConditions(q.filters, q.excludeInternal, 'raw', 'e', { ignoreEventKeys: true }))}
      ) t
      WHERE t.prev IS NOT NULL AND t.prev <> t.service
      GROUP BY t.prev, t.service
      ORDER BY count(*) DESC
      LIMIT ${q.limit}`, ctx.timeoutMs);
    return {
      type: 'journeys',
      pairs: rows.map((r) => {
        const masked = isMasked(Number(r.users), ctx.k);
        return {
          from: r.from as AnalyticsAreaKey,
          to: r.to as AnalyticsAreaKey,
          count: masked ? null : Number(r.count),
          users: masked ? null : Number(r.users),
          masked,
        };
      }),
    };
  }
}
