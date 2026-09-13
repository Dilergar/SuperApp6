import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { ANALYTICS_JOBS, ANALYTICS_QUEUE } from './analytics.constants';
import { isUuid } from './analytics.enrich';

const ERASE_BATCH = 5000;
/** Повторный проход забвения догоняет события, которые были в очереди в момент удаления */
const SECOND_PASS_DELAY_MS = 10 * 60_000;
/** Потолок анонимных id человека в payload (id — не объекты; больше устройств у одного человека не бывает) */
const MAX_ANON_IDS = 1000;

/**
 * Забвение сырья батчами. Строки партиционированной таблицы адресуются парой
 * `(event_id, ts)` (уникум), а НЕ `ctid`: ctid уникален только внутри партиции, и
 * `DELETE … WHERE ctid IN (…)` по родителю удалил бы чужие строки соседних месяцев.
 */
@Injectable()
export class AnalyticsEraseJobs implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsEraseJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    const opts = { queue: ANALYTICS_QUEUE, maxAttempts: 10, leaseMs: 30 * 60_000, queueConcurrency: 2 };
    this.registry.register(ANALYTICS_JOBS.userErase, (p) => this.eraseUser(p), opts);
    this.registry.register(ANALYTICS_JOBS.workspaceErase, (p) => this.eraseWorkspace(p), opts);
  }

  private async deleteEvents(where: Prisma.Sql): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.db.$executeRaw`
        DELETE FROM analytics.events
        WHERE (event_id, ts) IN (SELECT event_id, ts FROM analytics.events WHERE ${where} LIMIT ${ERASE_BATCH})`;
      total += n;
      if (n < ERASE_BATCH) return total;
    }
  }

  async eraseUser(payload: Record<string, unknown>): Promise<void> {
    const userId = payload.userId;
    if (!isUuid(userId)) throw new JobDiscardError('analytics.user.erase: invalid user id');
    const pass = payload.pass === 2 ? 2 : 1;
    // Анонимные id человека: из склеек (включая оспоренные — где он был первым) и из
    // payload первого прохода (склейки к этому моменту уже удалены)
    const linked = await this.db.analyticsIdentityLink.findMany({ where: { userId }, select: { anonymousId: true }, take: MAX_ANON_IDS });
    const carried = Array.isArray(payload.anonymousIds) ? (payload.anonymousIds as unknown[]).filter(isUuid) : [];
    const anonymousIds = [...new Set([...linked.map((l) => l.anonymousId), ...carried])].slice(0, MAX_ANON_IDS);

    const own = await this.deleteEvents(Prisma.sql`user_id = ${userId}::uuid`);
    const anon = anonymousIds.length ? await this.deleteEvents(Prisma.sql`anonymous_id = ANY(${anonymousIds}::uuid[])`) : 0;
    await this.db.$executeRaw`
      DELETE FROM analytics_rollup_actor_day
      WHERE actor_id = ${userId}::uuid OR actor_id = ANY(${anonymousIds}::uuid[])`;
    await this.db.$executeRaw`DELETE FROM analytics.outbox WHERE payload->>'userId' = ${userId}`;
    // Склейки — сразу: «вернувшийся человек — новый»; второму проходу id анонимов едут в payload
    await this.db.analyticsIdentityLink.deleteMany({ where: { userId } });
    if (pass === 1) {
      await this.jobs.enqueue(null, {
        type: ANALYTICS_JOBS.userErase,
        payload: { userId, pass: 2, anonymousIds },
        runAt: new Date(Date.now() + SECOND_PASS_DELAY_MS),
        uniqueKey: `erase:user:${userId}:2`,
      });
    }
    this.logger.log(`analytics erase user pass ${pass}: ${own + anon} events`);
  }

  async eraseWorkspace(payload: Record<string, unknown>): Promise<void> {
    const workspaceId = payload.workspaceId;
    if (!isUuid(workspaceId)) throw new JobDiscardError('analytics.workspace.erase: invalid workspace id');
    const pass = payload.pass === 2 ? 2 : 1;
    const n = await this.deleteEvents(Prisma.sql`workspace_id = ${workspaceId}::uuid`);
    await this.db.$executeRaw`DELETE FROM analytics_rollup_actor_day WHERE workspace_id = ${workspaceId}::uuid`;
    await this.db.$executeRaw`DELETE FROM analytics_rollup_event_day WHERE workspace_id = ${workspaceId}::uuid`;
    await this.db.$executeRaw`DELETE FROM analytics_rollup_session_day WHERE workspace_id = ${workspaceId}::uuid`;
    await this.db.$executeRaw`DELETE FROM analytics.outbox WHERE payload->>'workspaceId' = ${workspaceId}`;
    if (pass === 1) {
      await this.jobs.enqueue(null, {
        type: ANALYTICS_JOBS.workspaceErase,
        payload: { workspaceId, pass: 2 },
        runAt: new Date(Date.now() + SECOND_PASS_DELAY_MS),
        uniqueKey: `erase:workspace:${workspaceId}:2`,
      });
    }
    this.logger.log(`analytics erase workspace pass ${pass}: ${n} events`);
  }
}
