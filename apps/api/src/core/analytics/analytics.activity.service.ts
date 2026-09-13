import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ANALYTICS_PRODUCT_AREAS, type AnalyticsActivityPanelDto, type AnalyticsAreaKey } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { analyticsEnv } from './analytics.constants';
import { dayInZone, isUuid } from './analytics.enrich';
import { addDaysIso, dayStart } from './analytics.metrics';
import { AnalyticsReadDb } from './analytics.read-db';

const WINDOW_DAYS = 28;

/**
 * Панель «Активность» карточки 360. ТОЛЬКО агрегаты за 28 дней: последний активный день,
 * число активных дней, сервисы и платформы по дням, упоры в тариф по ключу. Ленты
 * событий человека нет и не будет — это не инструмент расследований (правда о
 * действиях — core/chatter). Право, бюджет просмотров и журнал чтений ставит кабинет.
 */
@Injectable()
export class AnalyticsActivityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly read: AnalyticsReadDb,
  ) {}

  private window() {
    const tz = analyticsEnv().timezone;
    const today = dayInZone(new Date(), tz);
    return { tz, today, from: addDaysIso(today, -(WINDOW_DAYS - 1)) };
  }

  async userPanel(userId: string): Promise<AnalyticsActivityPanelDto> {
    const empty: AnalyticsActivityPanelDto = { entity: 'user', lastActiveDay: null, activeDays28: 0, topServices28: [], platforms28: [], deniedKeys28: [], members: null, adoption28: null };
    if (!isUuid(userId)) return empty;
    const { tz, today, from } = this.window();
    const [summary, services, platforms, denied] = await Promise.all([
      this.read.query<{ last_day: string | null; active_days: number }>(Prisma.sql`
        SELECT
          (SELECT to_char(max(day), 'YYYY-MM-DD') FROM analytics_rollup_actor_day WHERE actor_id = ${userId}::uuid AND qualifying) AS last_day,
          (SELECT count(DISTINCT day)::int FROM analytics_rollup_actor_day
            WHERE actor_id = ${userId}::uuid AND qualifying AND day BETWEEN ${from}::date AND ${today}::date) AS active_days`),
      this.read.query<{ key: string; days: number }>(Prisma.sql`
        SELECT service AS key, count(DISTINCT day)::int AS days FROM analytics_rollup_actor_day
        WHERE actor_id = ${userId}::uuid AND qualifying AND day BETWEEN ${from}::date AND ${today}::date
        GROUP BY service ORDER BY days DESC, service LIMIT 8`),
      this.read.query<{ key: string; days: number }>(Prisma.sql`
        SELECT platform AS key, count(DISTINCT day)::int AS days FROM analytics_rollup_actor_day
        WHERE actor_id = ${userId}::uuid AND day BETWEEN ${from}::date AND ${today}::date
        GROUP BY platform ORDER BY days DESC`),
      this.read.query<{ key: string; count: number }>(Prisma.sql`
        SELECT props ->> 'key' AS key, count(*)::int AS count FROM analytics.events
        WHERE user_id = ${userId}::uuid AND event_key = 'entitlements.access.denied' AND ts >= ${dayStart(from, tz)}
        GROUP BY 1 ORDER BY count DESC LIMIT 10`),
    ]);
    return {
      ...empty,
      lastActiveDay: summary[0]?.last_day ?? null,
      activeDays28: Number(summary[0]?.active_days ?? 0),
      topServices28: services.map((s) => ({ service: s.key as AnalyticsAreaKey, days: Number(s.days) })),
      platforms28: platforms.map((p) => ({ platform: p.key, days: Number(p.days) })),
      deniedKeys28: denied.filter((d) => d.key).map((d) => ({ key: d.key, count: Number(d.count) })),
    };
  }

  async workspacePanel(workspaceId: string): Promise<AnalyticsActivityPanelDto> {
    const empty: AnalyticsActivityPanelDto = {
      entity: 'workspace',
      lastActiveDay: null,
      activeDays28: 0,
      topServices28: [],
      platforms28: [],
      deniedKeys28: [],
      members: { total: 0, active28: 0 },
      adoption28: [],
    };
    if (!isUuid(workspaceId)) return empty;
    const { tz, today, from } = this.window();
    const products = ANALYTICS_PRODUCT_AREAS as string[];
    const [total, summary, services, platforms, denied, adoption] = await Promise.all([
      this.db.workspaceMember.count({ where: { workspaceId } }),
      this.read.query<{ last_day: string | null; active_days: number; active_members: number }>(Prisma.sql`
        SELECT
          (SELECT to_char(max(day), 'YYYY-MM-DD') FROM analytics_rollup_actor_day WHERE workspace_id = ${workspaceId}::uuid AND qualifying) AS last_day,
          (SELECT count(DISTINCT day)::int FROM analytics_rollup_actor_day
            WHERE workspace_id = ${workspaceId}::uuid AND qualifying AND day BETWEEN ${from}::date AND ${today}::date) AS active_days,
          (SELECT count(DISTINCT actor_id)::int FROM analytics_rollup_actor_day
            WHERE workspace_id = ${workspaceId}::uuid AND qualifying AND actor_kind = 0 AND day BETWEEN ${from}::date AND ${today}::date) AS active_members`),
      this.read.query<{ key: string; days: number }>(Prisma.sql`
        SELECT service AS key, count(DISTINCT day)::int AS days FROM analytics_rollup_actor_day
        WHERE workspace_id = ${workspaceId}::uuid AND qualifying AND day BETWEEN ${from}::date AND ${today}::date
        GROUP BY service ORDER BY days DESC, service LIMIT 8`),
      this.read.query<{ key: string; days: number }>(Prisma.sql`
        SELECT platform AS key, count(DISTINCT day)::int AS days FROM analytics_rollup_actor_day
        WHERE workspace_id = ${workspaceId}::uuid AND day BETWEEN ${from}::date AND ${today}::date
        GROUP BY platform ORDER BY days DESC`),
      this.read.query<{ key: string; count: number }>(Prisma.sql`
        SELECT props ->> 'key' AS key, count(*)::int AS count FROM analytics.events
        WHERE workspace_id = ${workspaceId}::uuid AND event_key = 'entitlements.access.denied' AND ts >= ${dayStart(from, tz)}
        GROUP BY 1 ORDER BY count DESC LIMIT 10`),
      this.read.query<{ key: string; actors: number }>(Prisma.sql`
        SELECT service AS key, count(DISTINCT actor_id)::int AS actors FROM analytics_rollup_actor_day
        WHERE workspace_id = ${workspaceId}::uuid AND qualifying AND actor_kind = 0
          AND day BETWEEN ${from}::date AND ${today}::date AND service = ANY(${products}::text[])
        GROUP BY service ORDER BY actors DESC`),
    ]);
    const active28 = Number(summary[0]?.active_members ?? 0);
    return {
      ...empty,
      lastActiveDay: summary[0]?.last_day ?? null,
      activeDays28: Number(summary[0]?.active_days ?? 0),
      topServices28: services.map((s) => ({ service: s.key as AnalyticsAreaKey, days: Number(s.days) })),
      platforms28: platforms.map((p) => ({ platform: p.key, days: Number(p.days) })),
      deniedKeys28: denied.filter((d) => d.key).map((d) => ({ key: d.key, count: Number(d.count) })),
      members: { total, active28 },
      adoption28: adoption.map((a) => ({ service: a.key as AnalyticsAreaKey, share: active28 ? Math.round((Number(a.actors) / active28) * 1000) / 1000 : 0 })),
    };
  }
}
