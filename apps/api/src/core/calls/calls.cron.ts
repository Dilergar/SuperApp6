import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { CallsLivekitClient } from './calls-livekit.client';
import { CallsService } from './calls.service';
import { CallsRecordingService } from './calls-recording.service';

/**
 * Крон движка звонков: (1) реконсиляция зависших активных сессий (потерянный
 * room_finished, «токен выдан — никто не подключился»); (2) редрайв записей —
 * потерянный egress_ended (спросить egress сами), зависший ingesting, недоставленные
 * клеймы, сироты egress-каталога. Redis-лок — выполняет один инстанс; при
 * недоступном LiveKit реконсиляция пропускается внутри reconcileStale.
 */
@Injectable()
export class CallsCron {
  private readonly logger = new Logger(CallsCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly calls: CallsService,
    private readonly livekit: CallsLivekitClient,
    private readonly recording: CallsRecordingService,
  ) {}

  @Cron('*/2 * * * *')
  async reconcile(): Promise<void> {
    if (!this.livekit.enabled) return;
    await this.redis.withLock('cron:calls-reconcile', 60_000, async () => {
      try {
        const closed = await this.calls.reconcileStale();
        if (closed > 0) this.logger.log(`закрыто потерянных сессий: ${closed}`);
      } catch (err) {
        this.logger.warn(`reconcile: ${err instanceof Error ? err.message : err}`);
      }
      if (this.livekit.recordingEnabled) {
        try {
          await this.recording.redrive();
        } catch (err) {
          this.logger.warn(`recording redrive: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }
}
