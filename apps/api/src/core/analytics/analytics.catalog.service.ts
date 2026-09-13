import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ANALYTICS_EVENT_KEYS,
  ANALYTICS_REGISTRY,
  analyticsEnumPropsOf,
  type AnalyticsEventCatalogItemDto,
  type AnalyticsEventStatus,
  type AnalyticsQualityDto,
  type AnalyticsQuarantineReason,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { ANALYTICS_GROUP, ANALYTICS_REDIS, ANALYTICS_STREAM, analyticsEnv } from './analytics.constants';
import { dayInZone } from './analytics.enrich';
import { addDaysIso } from './analytics.metrics';
import { AnalyticsQueryService } from './analytics.query.service';
import { AnalyticsReadDb } from './analytics.read-db';

/** Каталог «Что мы измеряем» и витрина качества данных Кабинета. */
@Injectable()
export class AnalyticsCatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly read: AnalyticsReadDb,
    private readonly redis: RedisService,
    private readonly query: AnalyticsQueryService,
  ) {}

  async events(): Promise<AnalyticsEventCatalogItemDto[]> {
    const tz = analyticsEnv().timezone;
    const today = dayInZone(new Date(), tz);
    const from = addDaysIso(today, -13);
    const [overrides, volume, lastSeen] = await Promise.all([
      this.db.analyticsEventOverride.findMany(),
      this.read.query<{ key: string; day: string; n: number }>(Prisma.sql`
        SELECT event_key AS key, to_char(day, 'YYYY-MM-DD') AS day, sum(count)::int AS n
        FROM analytics_rollup_event_day WHERE day BETWEEN ${from}::date AND ${today}::date GROUP BY 1, 2`),
      this.read.query<{ key: string; day: string }>(Prisma.sql`
        SELECT event_key AS key, to_char(max(day), 'YYYY-MM-DD') AS day FROM analytics_rollup_event_day GROUP BY 1`),
    ]);
    const days = Array.from({ length: 14 }, (_, i) => addDaysIso(from, i));
    const vol = new Map<string, Map<string, number>>();
    for (const r of volume) {
      if (!vol.has(r.key)) vol.set(r.key, new Map());
      vol.get(r.key)!.set(r.day, Number(r.n));
    }
    const last = new Map(lastSeen.map((r) => [r.key, r.day]));
    const ov = new Map(overrides.map((o) => [o.eventKey, o]));
    return ANALYTICS_EVENT_KEYS.map((key) => {
      const def = ANALYTICS_REGISTRY[key];
      const o = ov.get(key);
      const series = days.map((d) => vol.get(key)?.get(d) ?? 0);
      const status: AnalyticsEventStatus = o?.status === 'blocked' ? 'blocked' : o?.status === 'live' && def.status === 'blocked' ? 'live' : def.status;
      return {
        key,
        service: def.service,
        source: def.source,
        class: def.class,
        qualifying: def.qualifying,
        anonymous: def.anonymous === true,
        version: def.version,
        registryStatus: def.status,
        status,
        override: o ? { status: o.status === 'blocked' ? 'blocked' : 'live', reason: o.reason, setBy: o.setBy, setAt: o.setAt.toISOString() } : null,
        volume14d: series,
        volume7d: series.slice(-7).reduce((s, n) => s + n, 0),
        lastSeenDay: last.get(key) ?? null,
        enumProps: analyticsEnumPropsOf(key),
      };
    });
  }

  async quality(): Promise<AnalyticsQualityDto> {
    const env = analyticsEnv();
    const client = this.redis.getClient();
    const [quarantine, outbox, lastHour, counters, rollupAt, length, groups, firstEventAt] = await Promise.all([
      this.db.analyticsQuarantine.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 200 }),
      this.read.query<{ n: number }>(Prisma.sql`SELECT count(*)::int AS n FROM analytics.outbox`),
      this.read.query<{ n: number }>(Prisma.sql`SELECT count(*)::int AS n FROM analytics.events WHERE ts >= now() - interval '1 hour'`),
      client.hgetall(ANALYTICS_REDIS.counters(new Date().toISOString().slice(0, 10))).catch(() => ({}) as Record<string, string>),
      this.redis.get(ANALYTICS_REDIS.rollupAt).catch(() => null),
      client.xlen(ANALYTICS_STREAM).catch(() => 0),
      (client.xinfo('GROUPS', ANALYTICS_STREAM) as Promise<unknown[]>).catch(() => [] as unknown[]),
      this.query.firstEventAt().catch(() => null),
    ]);
    // XINFO GROUPS — массив плоских списков [name, v, consumers, v, pending, v, last-delivered-id, v, entries-read, v, lag, v]
    let pending = 0;
    let lag = 0;
    let oldestPendingMs: number | null = null;
    for (const g of groups as unknown[][]) {
      const m = new Map<string, unknown>();
      for (let i = 0; i + 1 < g.length; i += 2) m.set(String(g[i]), g[i + 1]);
      if (m.get('name') !== ANALYTICS_GROUP) continue;
      pending = Number(m.get('pending') ?? 0);
      lag = Number(m.get('lag') ?? 0) || 0;
    }
    if (pending > 0) {
      try {
        const summary = (await client.xpending(ANALYTICS_STREAM, ANALYTICS_GROUP)) as [number, string | null, string | null, unknown];
        const minId = summary?.[1];
        if (minId) oldestPendingMs = Number(minId.split('-')[0]);
      } catch {
        /* диагностика */
      }
    }
    const c = counters as Record<string, string>;
    const n = (k: string) => Number(c[k] ?? 0) || 0;
    return {
      quarantine: quarantine.map((q) => ({
        id: q.id,
        eventKey: q.eventKey,
        reason: q.reason as AnalyticsQuarantineReason,
        count: q.count,
        firstSeenAt: q.firstSeenAt.toISOString(),
        lastSeenAt: q.lastSeenAt.toISOString(),
        sampleShape: (q.sampleShape ?? {}) as Record<string, string>,
      })),
      stream: {
        length: Number(length) || 0,
        maxLength: env.streamMaxLen,
        pending: pending + lag,
        lagSeconds: oldestPendingMs ? Math.max(0, Math.round((Date.now() - oldestPendingMs) / 1000)) : null,
      },
      outboxBacklog: Number(outbox[0]?.n ?? 0),
      counters: { accepted: n('accepted'), dropped: n('dropped'), redacted: n('redacted'), shed: n('shed'), blocked: n('blocked'), optedOut: n('optedOut') },
      eventsLastHour: Number(lastHour[0]?.n ?? 0),
      rollupAt,
      firstEventAt,
      timezone: env.timezone,
    };
  }
}
