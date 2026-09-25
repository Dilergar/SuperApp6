import { Injectable, OnModuleInit } from '@nestjs/common';
import { ANALYTICS_CLASS_CODE, ANALYTICS_OWNER_CODE, ANALYTICS_SOURCE_CODE, uuidv7 } from '@superapp/shared';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../lifecycle/lifecycle.purge.registry';
import { AnalyticsEraseJobs } from './analytics.jobs';
import { AnalyticsService } from './analytics.service';

/**
 * Шаги аналитики в жизненном цикле:
 *  - `analytics.workspace` — каскад организации (роллапы с измерением организации + сырьё):
 *    роллапы — пачками (не одним DELETE на сотни тысяч строк), сырьё — джобом движка
 *    батчами с повторным проходом (события, ещё летевшие в очереди, догоняются);
 *  - `analytics.subject` — стирание человека (политики `AnalyticsIdentityLink`,
 *    `AnalyticsRollupActorDay`, `analytics.events`): первый проход — СРАЗУ в шаге (сырьё его
 *    и анонимных id, роллапы, очередь приёма, склейки), второй — джобом через паузу:
 *    события, ещё летевшие в очереди приёма, догоняются.
 */
@Injectable()
export class AnalyticsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly analytics: AnalyticsService,
    private readonly eraseJobs: AnalyticsEraseJobs,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('analytics.workspace', {
      purge: (workspaceId, ctx) => this.analytics.forgetWorkspace(workspaceId, ctx.deadline),
      estimate: async (workspaceId) =>
        (await this.db.analyticsRollupEventDay.count({ where: { workspaceId } })) +
        (await this.db.analyticsRollupActorDay.count({ where: { workspaceId } })) +
        (await this.db.analyticsRollupSessionDay.count({ where: { workspaceId } })),
    });
    this.subjectHooks.register('analytics.subject', {
      erase: async (userId) => {
        const before = await this.db.analyticsRollupActorDay.count({ where: { actorId: userId } });
        await this.eraseJobs.eraseUser({ userId, pass: 1 });
        return { rows: before };
      },
    });
    this.canary.register('analytics.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: сырое событие человека (помечено внутренним — в продуктовые метрики не
   * попадает), склейка анонимного id и роллап актора за сегодня. Всё исчезает.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const eventId = uuidv7();
    const now = new Date();
    await this.db.$executeRaw`
      INSERT INTO analytics.events (event_id, ts, occurred_at, received_at, event_key, service, class, source, user_id, owner_type, platform, props, is_internal)
      VALUES (${eventId}::uuid, ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz, 'tasks.task.created', 'tasks',
              ${ANALYTICS_CLASS_CODE.business}::smallint, ${ANALYTICS_SOURCE_CODE.server}::smallint, ${ctx.userId}::uuid,
              ${ANALYTICS_OWNER_CODE.personal}::smallint, 'web', ${JSON.stringify({ canary: ctx.marker })}::jsonb, true)`;
    const anonymousId = randomUUID();
    await this.db.analyticsIdentityLink.create({ data: { anonymousId, userId: ctx.userId, source: 'login' } });
    const rollup = await this.db.analyticsRollupActorDay.create({
      data: { day: new Date(now.toISOString().slice(0, 10)), actorId: ctx.userId, service: 'tasks', platform: 'web', internal: true, events: 1, qualifying: false },
      select: { id: true },
    });
    return [
      { policy: 'table:analytics.events', id: eventId, key: 'event_id', expect: 'gone' },
      { policy: 'AnalyticsIdentityLink', id: anonymousId, expect: 'gone' },
      { policy: 'AnalyticsRollupActorDay', id: rollup.id.toString(), expect: 'gone' },
    ];
  }
}
