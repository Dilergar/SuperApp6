import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { AccessProjectionService } from './access-projection.service';

/**
 * Safety net for the access projection: re-syncs the tuple store against the domain
 * tables daily, repairing any drift left by a missed/failed best-effort live hook.
 * Runs on a single instance via a Redis lock (like the other crons).
 */
@Injectable()
export class AccessReconcileCron {
  private readonly logger = new Logger(AccessReconcileCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly projection: AccessProjectionService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async reconcile(): Promise<void> {
    await this.redis.withLock('cron:access-reconcile', 10 * 60 * 1000, async () => {
      const res = await this.projection.reconcile();
      const shops = await this.projection.backfillShops();
      const calendar = await this.projection.backfillCalendar();
      const tasks = await this.projection.backfillTasks();
      this.logger.log(`access reconcile: ${JSON.stringify({ ...res, shops, calendar, tasks })}`);
    });
  }
}
