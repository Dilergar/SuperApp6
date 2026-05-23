import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TasksService } from './tasks.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Time-manager background jobs. Both run under a Redis lock so exactly ONE
 * instance fires per tick (matching ContactsCron / NotificationsCron).
 */
@Injectable()
export class TasksCron {
  private readonly logger = new Logger(TasksCron.name);

  constructor(
    private tasks: TasksService,
    private redis: RedisService,
  ) {}

  // Deadline reminders — frequent, idempotent (reminderSentAt guards re-sends).
  @Cron('*/10 * * * *')
  async handleReminders() {
    const ran = await this.redis.withLock('cron:task-reminders', 5 * 60 * 1000, async () => {
      const n = await this.tasks.dispatchDueReminders();
      if (n > 0) this.logger.log(`Sent ${n} task reminder(s)`);
    });
    if (ran === null) this.logger.debug('Skipped reminders — another instance holds the lock');
  }

  // Overdue sweep — daily at 09:00. The 24h look-back window tiles the day so
  // each task that crosses its deadline is flagged exactly once.
  @Cron('0 9 * * *')
  async handleOverdue() {
    const ran = await this.redis.withLock('cron:task-overdue', 10 * 60 * 1000, async () => {
      const n = await this.tasks.dispatchOverdue();
      if (n > 0) this.logger.log(`Flagged ${n} overdue task(s)`);
    });
    if (ran === null) this.logger.debug('Skipped overdue sweep — another instance holds the lock');
  }
}
