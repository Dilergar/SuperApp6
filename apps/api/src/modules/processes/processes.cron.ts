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
      const BATCH = 500;

      // 1) Зависшие шаги (авто-нода упала ИЛИ wait так и не активировался). Пагинируем
      // курсором ДО ОПУСТОШЕНИЯ (P2): backlog не откладывается на 2-мин инкременты, как при
      // take(200). Сначала собираем kickable-инстансы (read-only), затем толкаем — так kick
      // (мутирующий) не ломает курсор. Потолок инстансов на прогон — от runaway-крона.
      const kickable = new Set<string>();
      let staleCursor: string | undefined;
      for (let pass = 0; pass < 20 && kickable.size < 1000; pass++) {
        const batch = await this.db.processStepRun.findMany({
          where: { status: 'active', startedAt: { lt: cutoff }, instance: { status: 'running' } },
          select: { id: true, instanceId: true, nodeType: true, activated: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(staleCursor ? { cursor: { id: staleCursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        staleCursor = batch[batch.length - 1].id;
        for (const s of batch) if (this.engine.isAutoType(s.nodeType) || !s.activated) kickable.add(s.instanceId);
        if (batch.length < BATCH) break;
      }
      for (const id of kickable) {
        try {
          await this.engine.kick(id);
        } catch (err) {
          this.logger.error(`recover kick(${id}) failed: ${(err as Error).message}`);
        }
      }
      if (kickable.size > 0) {
        this.logger.log(`recovered ${kickable.size} stalled process instance(s)`);
      }

      // 2) Сверка wait-шагов с их задачами — страховка от ПОТЕРЯННОГО сигнала (sync-хук
      // упал + at-most-once шина потеряла событие) и от отмены/удаления задачи в обход
      // хуков. Пагинируем ВСЕ ожидающие (P2) — иначе при >500 незакрытых часть задач НИКОГДА
      // не сверялась бы (потерянный сигнал в «слепой» половине не восстановился бы).
      const waitTaskIds: string[] = [];
      let waitCursor: string | undefined;
      for (let pass = 0; pass < 20 && waitTaskIds.length < 5000; pass++) {
        const batch = await this.db.processStepRun.findMany({
          where: { status: 'active', taskId: { not: null }, instance: { status: 'running' } },
          select: { id: true, taskId: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(waitCursor ? { cursor: { id: waitCursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        waitCursor = batch[batch.length - 1].id;
        for (const w of batch) if (w.taskId) waitTaskIds.push(w.taskId);
        if (batch.length < BATCH) break;
      }
      for (let i = 0; i < waitTaskIds.length; i += BATCH) {
        const chunk = waitTaskIds.slice(i, i + BATCH);
        const tasks = await this.db.task.findMany({ where: { id: { in: chunk } }, select: { id: true, status: true } });
        const statusById = new Map(tasks.map((t) => [t.id, t.status]));
        for (const taskId of chunk) {
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

      // 3b) A1+A8: добить зависшие слияния (ветку увёл condition/свой «Конец» —
      // arrivals<expected навсегда). Без этого инстанс висел бы running без сигнала.
      try {
        await this.engine.sweepStuckJoins();
      } catch (err) {
        this.logger.error(`stuck-joins: ${(err as Error).message}`);
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
