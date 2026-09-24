import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CALENDAR_LIMITS } from '@superapp/shared';
import { CalendarService } from './calendar.service';
import { RedisService } from '../../shared/redis/redis.service';

@Injectable()
export class CalendarCron {
  private readonly logger = new Logger(CalendarCron.name);

  constructor(
    private calendar: CalendarService,
    private redis: RedisService,
  ) {}

  // Напоминания больше не рассылает крон: каждое — джоб core/jobs с runAt=fireAt
  // (точность ~секунды, пропущенное не теряется). Здесь остались только горизонт и чистка.

  // Extend the reminder horizon for recurring events — daily at 03:15 UTC.
  @Cron('15 3 * * *')
  async handleTopUp() {
    const ran = await this.redis.withLock('cron:calendar-reminder-topup', 10 * 60 * 1000, async () => {
      const n = await this.calendar.topUpReminders();
      if (n > 0) this.logger.log(`Topped up reminders for ${n} recurring event(s)`);
      // Ремонт напоминаний без живого джоба: постановка джоба идёт отдельным стейтментом
      // после createMany, поэтому её сбой оставил бы «немое» напоминание до перезапуска.
      await this.calendar.repairReminderJobs();
    });
    if (ran === null) this.logger.debug('Skipped reminder top-up — another instance holds the lock');
  }

  // Purge SENT reminders older than 30 days — the table otherwise grows forever.
  @Cron('50 3 * * *')
  async handleSentPurge() {
    const ran = await this.redis.withLock('cron:calendar-reminder-purge', 10 * 60 * 1000, async () => {
      const n = await this.calendar.purgeSentReminders();
      if (n > 0) this.logger.log(`Purged ${n} sent calendar reminder(s)`);
    });
    if (ran === null) this.logger.debug('Skipped reminder purge — another instance holds the lock');
  }

  /** Корзина: что пролежало дольше срока — навсегда (батчами; окно обслуживания по Алматы). */
  @Cron('55 3 * * *', { timeZone: 'Asia/Almaty' })
  async handleTrashPurge() {
    const ran = await this.redis.withLock('cron:calendar-trash-purge', 10 * 60 * 1000, async () => {
      const cutoff = new Date(Date.now() - CALENDAR_LIMITS.trashRetentionDays * 86_400_000);
      let purged = 0;
      for (let pass = 0; pass < 20; pass++) {
        const n = await this.calendar.purgeExpired(cutoff);
        purged += n;
        if (n < CALENDAR_LIMITS.purgeBatch) break;
      }
      if (purged) this.logger.log(`Calendar trash: ${purged} event(s) deleted for good`);
    });
    if (ran === null) this.logger.debug('Skipped trash purge — another instance holds the lock');
  }
}
