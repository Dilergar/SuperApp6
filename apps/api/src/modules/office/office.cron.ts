import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { OfficeService } from './office.service';

/**
 * Крон Виртуального офиса: авто-завершение встреч-«сирот» (без созвона дольше
 * OFFICE_LIMITS.autoEndIdleHours) — список «Идут сейчас» чистится сам к концу дня.
 * Redis-лок — выполняет один инстанс.
 */
@Injectable()
export class OfficeCron {
  private readonly logger = new Logger(OfficeCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly office: OfficeService,
  ) {}

  @Cron('*/15 * * * *')
  async autoEnd(): Promise<void> {
    await this.redis.withLock('cron:office-rooms', 60_000, async () => {
      try {
        const ended = await this.office.autoEndIdle();
        if (ended > 0) this.logger.log(`авто-завершено простаивающих встреч: ${ended}`);
      } catch (err) {
        this.logger.warn(`autoEnd: ${err instanceof Error ? err.message : err}`);
      }
      // Сверка: снять участия людей, выбывших из организации (дрейф синхронного отзыва)
      try {
        const cleaned = await this.office.reconcileOrphanParticipants();
        if (cleaned > 0) this.logger.log(`снято осиротевших участий во встречах: ${cleaned}`);
      } catch (err) {
        this.logger.warn(`reconcileOrphanParticipants: ${err instanceof Error ? err.message : err}`);
      }
    });
  }
}
