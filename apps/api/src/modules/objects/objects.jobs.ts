import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { JobsRegistry, JobDiscardError } from '../../core/jobs/jobs.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { RedisService } from '../../shared/redis/redis.service';
import { StaffService } from '../staff/staff.service';
import { ShiftsService } from './shifts.service';
import { ASSIGNMENT_ROLLOVER_JOB, OBJECTS_QUEUE, SHIFTS_GENERATE_JOB } from './objects.job-types';

// Константы типов — в отдельном файле (их импортируют и те, кто ставит джоб из
// своей транзакции); здесь ре-экспорт для прежних импортов.
export { OBJECTS_QUEUE, SHIFTS_GENERATE_JOB, ASSIGNMENT_ROLLOVER_JOB } from './objects.job-types';

type Tx = Prisma.TransactionClient;

/**
 * Фоновая работа сервиса «Объекты».
 *
 * `staff.assignment.rollover` — единственный честный способ увидеть НАСТУПЛЕНИЕ и
 * ИСТЕЧЕНИЕ даты: событий у времени нет, а tuples прав дат не несут. Джоб ставится
 * `enqueue(tx)` в транзакции правки дат и в полночь пересобирает проекцию прав.
 * Страховка — ночной reconcile проекции (он же чинит дрейф).
 *
 * `objects.shifts.generate` — порождение смен по ротации на горизонт;
 * идемпотентно рукописным уникумом `shifts_pattern_slot_key`.
 */
@Injectable()
export class ObjectsJobs implements OnModuleInit {
  private readonly logger = new Logger(ObjectsJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly redis: RedisService,
    private readonly staff: StaffService,
    private readonly shifts: ShiftsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      ASSIGNMENT_ROLLOVER_JOB,
      async (payload) => {
        const workspaceId = String(payload.workspaceId ?? '');
        if (!workspaceId) throw new JobDiscardError('нет workspaceId');
        const exists = await this.db.workspace.count({ where: { id: workspaceId } });
        // Организацию удалили — пересобирать нечего (постоянная ошибка).
        if (!exists) throw new JobDiscardError('организация удалена');
        await this.staff.afterStructureChanged(workspaceId);
      },
      { queue: OBJECTS_QUEUE, maxAttempts: 5 },
    );

    this.registry.register(
      SHIFTS_GENERATE_JOB,
      async (payload) => {
        const patternId = String(payload.patternId ?? '');
        if (!patternId) throw new JobDiscardError('нет patternId');
        const pattern = await this.db.shiftPattern.findUnique({ where: { id: patternId } });
        // Ротацию удалили или отправили в архив — генерировать нечего.
        if (!pattern || pattern.archivedAt) throw new JobDiscardError('ротация удалена');
        await this.shifts.generateFromPattern(patternId);
      },
      { queue: OBJECTS_QUEUE, maxAttempts: 5 },
    );
  }

  /**
   * Поставить пересборку прав на ПОЛНОЧЬ в поясе объекта — в той же транзакции,
   * что и правка дат назначения (правило движка джобов).
   */
  async enqueueRollover(
    tx: Tx | null,
    workspaceId: string,
    assignmentId: string,
    dateISO: string,
    timeZone: string,
  ): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: ASSIGNMENT_ROLLOVER_JOB,
      payload: { workspaceId, assignmentId },
      runAt: midnightIn(dateISO, timeZone),
      uniqueKey: `sa:${assignmentId}:${dateISO}`,
    });
  }

  /** Поставить генерацию смен по ротации (идемпотентно на неделю). */
  async enqueueGenerate(tx: Tx | null, patternId: string, weekStart: string): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: SHIFTS_GENERATE_JOB,
      payload: { patternId, weekStart },
      uniqueKey: `sp:${patternId}:${weekStart}`,
    });
  }

  /**
   * Еженедельная догенерация горизонта (пн 03:10). Под Redis-локом: инстансов
   * несколько, крон должен отработать один раз.
   */
  @Cron('10 3 * * 1')
  async generateHorizon(): Promise<void> {
    // Инстансов несколько — крон отрабатывает один раз (Redis-лок движка).
    const token = await this.redis.acquireLock('cron:objects:shifts-horizon', 55 * 60 * 1000);
    if (!token) return;
    const patterns = await this.db.shiftPattern.findMany({
      where: { archivedAt: null, OR: [{ activeTo: null }, { activeTo: { gte: new Date() } }] },
      select: { id: true },
      take: 5000,
    });
    // Ключ идемпотентности — НАЧАЛО НЕДЕЛИ, а не сегодняшняя дата: иначе
    // `uniqueKey sp:<pattern>:<week>` из канона был бы посуточным и не защищал
    // от повторной постановки внутри той же недели.
    const weekStart = ShiftsService.weekKey(new Date().toISOString().slice(0, 10));
    for (const p of patterns) {
      await this.enqueueGenerate(null, p.id, weekStart).catch((e) =>
        this.logger.warn(`enqueue generate ${p.id}: ${(e as Error).message}`),
      );
    }
  }
}

/** Полночь указанной даты в поясе объекта → момент UTC. */
export function midnightIn(dateISO: string, timeZone: string): Date {
  // Смещение пояса на эту дату: сравниваем «как выглядит полночь UTC в поясе».
  const utcMidnight = new Date(`${dateISO}T00:00:00.000Z`);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(utcMidnight);
  const get = (t: string) => Number(shown.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  const offsetMs = asUtc - utcMidnight.getTime();
  return new Date(utcMidnight.getTime() - offsetMs);
}
