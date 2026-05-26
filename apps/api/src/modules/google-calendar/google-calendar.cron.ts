import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GoogleCalendarService } from './google-calendar.service';
import { RedisService } from '../../shared/redis/redis.service';

@Injectable()
export class GoogleCalendarCron {
  private readonly logger = new Logger(GoogleCalendarCron.name);

  constructor(
    private google: GoogleCalendarService,
    private redis: RedisService,
  ) {}

  // Poll fallback (when webhooks unavailable) + renew expiring push channels.
  @Cron('*/15 * * * *')
  async poll() {
    if (!this.google.isConfigured()) return;
    await this.redis.withLock('cron:google-sync', 13 * 60 * 1000, async () => {
      const n = await this.google.pollAndRenew();
      if (n > 0) this.logger.log(`Polled ${n} Google connection(s)`);
    });
  }
}
