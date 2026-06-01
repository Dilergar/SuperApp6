import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { SearchRegistry } from './search.registry';

/**
 * Safety net for the search index: nightly, each provider that implements reconcile() does a
 * BOUNDED repair (e.g. re-index items changed in the last day + small entity sets), catching
 * anything a missed best-effort live hook dropped. Single instance via Redis lock. The full
 * (unbounded) initial build lives in scripts/backfill-search.cjs.
 */
@Injectable()
export class SearchReconcileCron {
  private readonly logger = new Logger(SearchReconcileCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly registry: SearchRegistry,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async reconcile(): Promise<void> {
    await this.redis.withLock('cron:search-reconcile', 10 * 60 * 1000, async () => {
      const report: Record<string, number> = {};
      for (const provider of this.registry.all()) {
        if (!provider.reconcile) continue;
        try {
          report[provider.type] = await provider.reconcile();
        } catch (e) {
          this.logger.warn(`search reconcile "${provider.type}" failed: ${String(e)}`);
        }
      }
      this.logger.log(`search reconcile: ${JSON.stringify(report)}`);
    });
  }
}
