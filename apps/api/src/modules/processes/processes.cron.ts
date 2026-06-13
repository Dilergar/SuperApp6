import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { ProcessEngineService } from './process-engine.service';
import { ProcessTriggerRouter } from './process-triggers.service';

/**
 * Восстановление зависших инстансов (durable-гарантия движка): упали между
 * транзакциями / проиграли лок — крон толкает kick, который добивает авто-цепочку.
 * Шаги-ожидания с taskId не трогаем (они легитимно ждут людей днями).
 */
@Injectable()
export class ProcessesCron {
  private readonly logger = new Logger(ProcessesCron.name);

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private engine: ProcessEngineService,
    private triggers: ProcessTriggerRouter,
  ) {}

  @Cron('*/2 * * * *')
  async recoverStalled(): Promise<void> {
    await this.redis.withLock('cron:processes-recover', 90_000, async () => {
      const cutoff = new Date(Date.now() - 2 * 60_000);
      const stale = await this.db.processStepRun.findMany({
        where: {
          status: 'active',
          startedAt: { lt: cutoff },
          instance: { status: 'running' },
        },
        select: { instanceId: true, nodeType: true, activated: true },
        take: 200,
      });
      const instanceIds = new Set<string>();
      for (const s of stale) {
        // авто-нода зависла ИЛИ wait-нода так и не активировалась (side-effect не отработал)
        if (this.engine.isAutoType(s.nodeType) || !s.activated) instanceIds.add(s.instanceId);
      }
      for (const id of instanceIds) {
        try {
          await this.engine.kick(id);
        } catch (err) {
          this.logger.error(`recover kick(${id}) failed: ${(err as Error).message}`);
        }
      }
      if (instanceIds.size > 0) {
        this.logger.log(`recovered ${instanceIds.size} stalled process instance(s)`);
      }

      // 2) Сверка wait-шагов с их задачами — страховка от ПОТЕРЯННОГО сигнала
      // (sync-хук упал + at-most-once шина потеряла событие) и от отмены/удаления
      // задачи в обход хуков. Без этого инстанс ждал бы вечно.
      const waiting = await this.db.processStepRun.findMany({
        where: { status: 'active', taskId: { not: null }, instance: { status: 'running' } },
        select: { taskId: true },
        take: 500,
      });
      const taskIds = waiting.map((w) => w.taskId).filter((x): x is string => !!x);
      if (taskIds.length > 0) {
        const tasks = await this.db.task.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, status: true },
        });
        const statusById = new Map(tasks.map((t) => [t.id, t.status]));
        for (const taskId of taskIds) {
          const status = statusById.get(taskId);
          try {
            if (status === 'done') await this.engine.onTaskCompleted(taskId);
            else if (status === 'cancelled') await this.engine.onTaskCancelled(taskId);
            else if (!status) await this.engine.onTaskDeleted(taskId);
          } catch (err) {
            this.logger.error(`task sweep (${taskId}, ${status}): ${(err as Error).message}`);
          }
        }
      }

      // 3) Ф2: добить истёкшие паузы + эскалация просроченных человеческих шагов.
      try {
        await this.engine.runDueTimersAndEscalations();
      } catch (err) {
        this.logger.error(`timers/escalations: ${(err as Error).message}`);
      }

      // 4) Ф3: запустить процессы по расписанию.
      try {
        await this.triggers.runDueSchedules();
      } catch (err) {
        this.logger.error(`schedules: ${(err as Error).message}`);
      }
    });
  }
}
