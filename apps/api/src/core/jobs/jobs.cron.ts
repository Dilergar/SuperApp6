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
  private async guarded(
    name: string,
    lock: string,
    ttlMs: number,
    fn: () => Promise<void>,
    opts?: { runWithoutLock?: boolean },
  ): Promise<void> {
    let started = false;
    try {
      await this.redis.withLock(lock, ttlMs, async () => {
        started = true;
        await fn();
      });
      return;
    } catch (err) {
      this.logger.warn(`${name} failed: ${String((err as Error)?.message ?? err)}`);
      // `started` отсекает случай «работа началась и упала сама» — её повторять нельзя.
      // Сюда же НЕ попадает «лок занят соседом»: withLock тогда возвращает null без
      // исключения. Значит остаётся ровно одно — не удалось обратиться к Redis.
      if (started || !opts?.runWithoutLock) return;
    }
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`${name} (без лока) failed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  @Cron('* * * * *')
  async reap(): Promise<void> {
    // runWithoutLock: reaper — ЕДИНСТВЕННЫЙ путь восстановления после краха инстанса.
    // Если он не отработает, взятые джобы останутся в executing до тех пор, пока не
    // поднимут Redis, — то есть недоступность кэша останавливала бы всю фоновую
    // работу платформы. Сам reaper идемпотентен и защищён гвардами (status, attempts),
    // поэтому параллельный прогон на нескольких инстансах дешевле простоя.
    await this.guarded('reap', 'cron:jobs-reaper', 55_000, () => this.jobs.reapExpired(), {
      runWithoutLock: true,
    });
  }

  /**
   * Часовая сверка реестра с таблицей: (1) тип переехал в другую очередь — двигаем
   * строки; (2) тип БЕЗ обработчика — только называем в логе (бессмертные строки
   * должны быть видны, но авто-чистка запрещена: чаще всего это выключенная фича,
   * а не мёртвый тип — см. JobsService.listUnhandled).
   */
  @Cron('50 * * * *')
  async queueFixup(): Promise<void> {
    await this.guarded('queue fixup', 'cron:jobs-queue-fixup', 10 * 60_000, async () => {
      await this.jobs.fixStrandedQueues();
      await this.jobs.reportUnhandled();
    });
  }

  @Cron('20 4 * * *')
  async retention(): Promise<void> {
    await this.guarded('retention', 'cron:jobs-retention', 30 * 60_000, () =>
      this.jobs.pruneTerminal(),
    );
  }
}
