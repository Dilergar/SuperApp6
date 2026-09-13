import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ANALYTICS_LIMITS, ANALYTICS_QUALIFYING_KEYS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { ANALYTICS_JOBS, ANALYTICS_QUEUE, ANALYTICS_REDIS, analyticsEnv } from './analytics.constants';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Роллапы дня (джоб `analytics.rollup.day`). Идемпотентно: день пересчитывается
 * ЦЕЛИКОМ — DELETE + INSERT трёх таблиц в одной транзакции под advisory-локом дня (два
 * инстанса не пересчитывают один день наперегонки). Сырьё дня копируется во временную
 * таблицу один раз, с ретро-склейкой анонимных событий (связь не оспорена, событие не
 * старше `identityRelinkDays` до привязки).
 */
@Injectable()
export class AnalyticsRollupService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsRollupService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly registry: JobsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      ANALYTICS_JOBS.rollupDay,
      async (payload) => {
        const day = payload.day;
        if (typeof day !== 'string' || !DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
          throw new JobDiscardError('analytics.rollup.day: invalid day');
        }
        await this.rollupDay(day);
      },
      { queue: ANALYTICS_QUEUE, maxAttempts: 5, leaseMs: 15 * 60_000, queueConcurrency: 2 },
    );
  }

  async rollupDay(day: string): Promise<{ events: number; actors: number; sessions: number }> {
    const tz = analyticsEnv().timezone;
    const started = Date.now();
    const out = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`analytics-rollup:${day}`}))::text AS locked`;
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE analytics_rollup_src (
            event_key text, service text, platform text, plan_key text, workspace_id uuid, session_id uuid,
            ts timestamptz, is_internal boolean, sample_rate real, user_id uuid, anonymous_id uuid
          ) ON COMMIT DROP`);
        await tx.$executeRaw`
          INSERT INTO analytics_rollup_src
          SELECT e.event_key, e.service, e.platform, e.plan_key, e.workspace_id, e.session_id, e.ts, e.is_internal, e.sample_rate,
            COALESCE(
              e.user_id,
              CASE WHEN l.contested = false
                    AND e.ts >= (l.linked_at AT TIME ZONE 'UTC') - make_interval(days => ${ANALYTICS_LIMITS.identityRelinkDays}::int)
                   THEN l.user_id END
            ),
            e.anonymous_id
          FROM analytics.events e
          LEFT JOIN analytics_identity_links l ON e.user_id IS NULL AND l.anonymous_id = e.anonymous_id
          WHERE e.ts >= ((${day}::date)::timestamp AT TIME ZONE ${tz})
            AND e.ts < (((${day}::date) + 1)::timestamp AT TIME ZONE ${tz})`;

        await tx.$executeRaw`DELETE FROM analytics_rollup_event_day WHERE day = ${day}::date`;
        await tx.$executeRaw`DELETE FROM analytics_rollup_actor_day WHERE day = ${day}::date`;
        await tx.$executeRaw`DELETE FROM analytics_rollup_session_day WHERE day = ${day}::date`;

        const events = await tx.$executeRaw`
          INSERT INTO analytics_rollup_event_day (day, workspace_id, service, event_key, platform, plan_key, internal, count, users, workspaces)
          SELECT ${day}::date, workspace_id, service, event_key, platform, plan_key, is_internal,
            round(sum(1.0 / GREATEST(sample_rate, 0.0001)))::int,
            count(DISTINCT COALESCE(user_id, anonymous_id))::int,
            count(DISTINCT workspace_id)::int
          FROM analytics_rollup_src
          GROUP BY workspace_id, service, event_key, platform, plan_key, is_internal`;

        const actors = await tx.$executeRaw`
          INSERT INTO analytics_rollup_actor_day (day, actor_id, actor_kind, workspace_id, service, platform, plan_key, internal, events, qualifying)
          SELECT ${day}::date, COALESCE(user_id, anonymous_id), CASE WHEN user_id IS NULL THEN 1 ELSE 0 END,
            workspace_id, service, platform, plan_key, bool_or(is_internal), count(*)::int,
            bool_or(event_key = ANY(${ANALYTICS_QUALIFYING_KEYS as string[]}::text[]))
          FROM analytics_rollup_src
          WHERE COALESCE(user_id, anonymous_id) IS NOT NULL
          GROUP BY COALESCE(user_id, anonymous_id), CASE WHEN user_id IS NULL THEN 1 ELSE 0 END, workspace_id, service, platform, plan_key`;

        // Сессия относится к первой организации, в которой случилась; платформа — клиентская
        // (серверные события той же сессии несут platform = server)
        const sessions = await tx.$executeRaw`
          INSERT INTO analytics_rollup_session_day (day, workspace_id, platform, internal, sessions, duration_p50_s, events_per_session)
          SELECT ${day}::date, ws, platform, internal, count(*)::int,
            COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dur)), 0)::int,
            avg(n)::real
          FROM (
            SELECT session_id,
              (array_agg(workspace_id ORDER BY ts) FILTER (WHERE workspace_id IS NOT NULL))[1] AS ws,
              COALESCE(min(platform) FILTER (WHERE platform <> 'server'), 'server') AS platform,
              bool_or(is_internal) AS internal,
              extract(epoch FROM max(ts) - min(ts)) AS dur,
              count(*) AS n
            FROM analytics_rollup_src
            WHERE session_id IS NOT NULL
            GROUP BY session_id
          ) s
          GROUP BY ws, platform, internal`;
        return { events, actors, sessions };
      },
      { timeout: 10 * 60_000, maxWait: 30_000 },
    );
    try {
      await this.redis.set(ANALYTICS_REDIS.rollupAt, new Date().toISOString());
    } catch {
      /* подпись «обновлено» — не повод ронять джоб */
    }
    this.logger.debug?.(`analytics rollup ${day}: ${out.events}/${out.actors}/${out.sessions} rows in ${Date.now() - started} ms`);
    return out;
  }
}
