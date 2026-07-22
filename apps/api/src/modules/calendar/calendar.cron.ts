import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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
}
