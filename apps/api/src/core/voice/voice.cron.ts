import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { VoiceService } from './voice.service';

/**
 * Крон голосового движка: добивает потерянные queued (упавший fire-and-forget)
 * и протухшие processing (инстанс умер посреди джоба — Redis-лок истёк).
 * Redis-лок крона — выполняет один инстанс.
 */
@Injectable()
export class VoiceCron {
  private readonly logger = new Logger(VoiceCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly voice: VoiceService,
  ) {}

  @Cron('*/2 * * * *')
  async redrive(): Promise<void> {
    await this.redis.withLock('cron:voice-transcripts', 90_000, async () => {
      try {
        const kicked = await this.voice.redriveStuck();
        if (kicked > 0) this.logger.log(`re-kick транскрипций: ${kicked}`);
      } catch (err) {
        this.logger.warn(`redrive: ${err instanceof Error ? err.message : err}`);
      }
    });
  }
}
