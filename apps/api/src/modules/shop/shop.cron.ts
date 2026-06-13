import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ShopService } from './shop.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * My Wish & Shop background sweep (Phase 7), under a Redis lock so exactly ONE instance fires per
 * tick (matching TasksCron / ContactsCron): auto-archives lots past their availability window and
 * auto-refunds crowdfunding campaigns that passed their deadline unfilled.
 */
@Injectable()
export class ShopCron {
  private readonly logger = new Logger(ShopCron.name);

  constructor(
    private readonly shop: ShopService,
    private readonly redis: RedisService,
  ) {}

  @Cron('*/30 * * * *')
  async sweep() {
    const ran = await this.redis.withLock('cron:shop-sweep', 10 * 60 * 1000, async () => {
      const archived = await this.shop.archiveExpiredListings();
      const expired = await this.shop.expireCampaigns();
      // Safety net: settle confirmed «с задачей» orders whose fulfilment task is done but whose
      // settle signal was lost (crash / at-most-once bus). Idempotent.
      const settled = await this.shop.settleCompletedFulfilments();
      if (archived > 0 || expired > 0 || settled > 0) {
        this.logger.log(
          `Shop sweep: archived ${archived} listing(s), refunded ${expired} expired campaign(s), settled ${settled} stuck fulfilment(s)`,
        );
      }
    });
    if (ran === null) this.logger.debug('Skipped shop sweep — another instance holds the lock');
  }
}
