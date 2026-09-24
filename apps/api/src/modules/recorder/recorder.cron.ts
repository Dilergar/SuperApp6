import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RECORDER_LIMITS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { RecorderService } from './recorder.service';

/**
 * Обслуживание Диктофона под Redis-локом: в мультиинстансной раскатке прогон делает ровно
 * один процесс. Корзина: что пролежало дольше срока — навсегда (файл и транскрипт прибирают
 * движки файлов и голоса).
 */
@Injectable()
export class RecorderCron {
  private readonly logger = new Logger(RecorderCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly recorder: RecorderService,
  ) {}

  @Cron('5 4 * * *', { timeZone: 'Asia/Almaty' })
  async purgeTrash(): Promise<void> {
    const ran = await this.redis.withLock('cron:recorder-trash-purge', 10 * 60 * 1000, async () => {
      const cutoff = new Date(Date.now() - RECORDER_LIMITS.trashRetentionDays * 86_400_000);
      let purged = 0;
      for (let pass = 0; pass < 20; pass++) {
        const n = await this.recorder.purgeExpired(cutoff);
        purged += n;
        if (n < RECORDER_LIMITS.purgeBatch) break;
      }
      if (purged) this.logger.log(`Recorder trash: ${purged} recording(s) deleted for good`);
    });
    if (ran === null) this.logger.debug('Skipped trash purge — another instance holds the lock');
  }
}
