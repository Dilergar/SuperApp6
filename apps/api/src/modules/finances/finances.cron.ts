import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { FinancesService } from './finances.service';

/**
 * FinanceCron (Redis-лок — один инстанс за тик): каждые 30 минут
 *  1) срабатывания повторяющихся операций (авто-запись / напоминание «Записать сейчас»);
 *  2) напоминания «сегодня платёж по долгу» (дедуп раз в день через debtRemindedAt).
 * Двойной прогон повторов невозможен: срабатывание клеймится атомарным сдвигом nextRunAt.
 */
@Injectable()
export class FinancesCron {
  private readonly logger = new Logger(FinancesCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly finances: FinancesService,
  ) {}

  @Cron('*/30 * * * *')
  async tick() {
    const ran = await this.redis.withLock('cron:finance', 5 * 60 * 1000, async () => {
      const recurring = await this.finances.processDueRecurring();
      const reminders = await this.finances.processDebtReminders();
      if (recurring || reminders) {
        this.logger.log(`Finance cron: повторов ${recurring}, напоминаний по долгам ${reminders}`);
      }
      return recurring + reminders;
    });
    if (ran === null) this.logger.debug('Skipped finance cron — another instance holds the lock');
  }

  /**
   * Ночная страховка отзыва доступа к книгам: гранты без живого ContactLink отзываются
   * (третий ремень после синхронного вызова из ContactsService и шины FinancesEvents).
   */
  @Cron('45 3 * * *')
  async sweepShares() {
    const ran = await this.redis.withLock('cron:finance-share-sweep', 10 * 60 * 1000, async () => {
      const revoked = await this.finances.sweepOrphanFinbookShares();
      if (revoked) {
        this.logger.warn(`Finance share sweep: отозвано осиротевших грантов книг: ${revoked}`);
      }
      return revoked;
    });
    if (ran === null) this.logger.debug('Skipped finance share sweep — lock held elsewhere');
  }
}
