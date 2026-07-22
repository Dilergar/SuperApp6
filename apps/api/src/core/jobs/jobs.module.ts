import { Global, Module, OnModuleInit } from '@nestjs/common';
import { DEV_ECHO_TYPE, JobsController } from './jobs.controller';
import { JobsCron } from './jobs.cron';
import { JobDiscardError, JobsRegistry } from './jobs.registry';
import { JobsService } from './jobs.service';
import { JobsWorker } from './jobs.worker';

/**
 * core/jobs — 10-й платформенный движок: фоновые джобы / transactional outbox
 * (модель Oban/River/Solid Queue). @Global: доменные сервисы ставят джобы через
 * JobsService.enqueue(tx, …) в СВОЕЙ транзакции (коммит = джоб есть, откат =
 * джоба нет) и регистрируют обработчики в JobsRegistry (onModuleInit, паттерн
 * files/calls/chatter). Исполнение at-least-once → обработчики идемпотентны.
 *
 * ПРАВИЛО ПЛАТФОРМЫ: на EventBus — только необязательные сигналы (потерялось —
 * не страшно); всё обязательное — сюда.
 */
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobsService, JobsRegistry, JobsWorker, JobsCron],
  exports: [JobsService, JobsRegistry],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly registry: JobsRegistry) {}

  /** Тест-обработчик дев-полигона (verify-jobs.cjs): управляемые фейлы/сон/discard. */
  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'development') return;
    this.registry.register(
      DEV_ECHO_TYPE,
      async (payload, ctx) => {
        const p = payload as { sleepMs?: number; failTimes?: number; discard?: boolean };
        if (p.sleepMs) await new Promise((r) => setTimeout(r, p.sleepMs));
        if (p.discard) throw new JobDiscardError('dev discard');
        if (p.failTimes && ctx.attempt <= p.failTimes) {
          throw new Error(`dev fail #${ctx.attempt}`);
        }
      },
      // Быстрый бэкофф — verify не ждёт минутами; лимиты остальным типам не навязывает.
      { maxAttempts: 3, backoffBaseMs: 500 },
    );
  }
}
