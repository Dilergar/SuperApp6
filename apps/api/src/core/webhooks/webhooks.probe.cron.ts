import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WEBHOOK_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { WEBHOOK_JOBS, WEBHOOK_LOCKS } from './webhooks.constants';

/**
 * Ежедневно: аудит битой подписью для живых endpoint'ов (раз в `probeIntervalHours`) и
 * ретеншн доставок (`deliveryRetentionDays`). Под Redis-локом — один инстанс.
 */
@Injectable()
export class WebhooksProbeCron {
  private readonly logger = new Logger(WebhooksProbeCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async daily(): Promise<void> {
    await this.redis.withLock(WEBHOOK_LOCKS.daily, 600_000, async () => {
      const probes = await this.enqueueProbes();
      const purged = await this.retention();
      if (probes || purged) this.logger.log(`webhooks daily: probes=${probes} purged=${purged}`);
    });
  }

  async enqueueProbes(): Promise<number> {
    const since = new Date(Date.now() - WEBHOOK_LIMITS.probeIntervalHours * 3_600_000);
    const rows = await this.db.webhookEndpoint.findMany({ where: { status: 'active', OR: [{ lastProbeAt: null }, { lastProbeAt: { lt: since } }] }, select: { id: true }, take: 5000 });
    let n = 0;
    for (const r of rows) {
      const { inserted } = await this.jobs.enqueue(null, { type: WEBHOOK_JOBS.probe, payload: { endpointId: r.id }, uniqueKey: r.id });
      if (inserted) n++;
    }
    return n;
  }

  async retention(): Promise<number> {
    const cutoff = new Date(Date.now() - WEBHOOK_LIMITS.deliveryRetentionDays * 86_400_000);
    const { count } = await this.db.webhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff }, status: { in: ['delivered', 'exhausted'] } } });
    return count;
  }
}
