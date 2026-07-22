import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from './jobs.service';

/**
 * Обслуживание движка джобов — ЕДИНСТВЕННЫЙ крон на все типы (вместо личного
 * редрайв-крона у каждого потребителя): reaper протухших аренд каждую минуту,
 * фиксап очередей раз в час, ретеншн терминальных строк раз в сутки.
 */
@Injectable()
export class JobsCron {
  private readonly logger = new Logger(JobsCron.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * try/catch снаружи withLock: недоступный Redis роняет САМ захват лока, и без обёртки
   * это улетало бы unhandled-rejection'ом из тика планировщика (reaper — единственный
   * путь восстановления после краха инстанса, о его простое нужно знать по логу).
   */
  private async guarded(name: string, lock: string, ttlMs: number, fn: () => Promise<void>): Promise<void> {
    try {
      await this.redis.withLock(lock, ttlMs, async () => {
        await fn();
      });
    } catch (err) {
      this.logger.warn(`${name} failed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  @Cron('* * * * *')
  async reap(): Promise<void> {
    await this.guarded('reap', 'cron:jobs-reaper', 55_000, () => this.jobs.reapExpired());
  }

  @Cron('50 * * * *')
  async queueFixup(): Promise<void> {
    await this.guarded('queue fixup', 'cron:jobs-queue-fixup', 10 * 60_000, () =>
      this.jobs.fixStrandedQueues(),
    );
  }

  @Cron('20 4 * * *')
  async retention(): Promise<void> {
    await this.guarded('retention', 'cron:jobs-retention', 30 * 60_000, () =>
      this.jobs.pruneTerminal(),
    );
  }
}
