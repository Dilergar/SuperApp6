import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JOB_LIMITS, JobStatsDto, JobStatus } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { EventBusService } from '../../shared/events/event-bus.service';
import { JobDiscardError, JobsRegistry, JobTypeDef } from './jobs.registry';

type Tx = Prisma.TransactionClient;

export interface EnqueueInput {
  type: string;
  /** ТОЛЬКО id-шки, не объекты (правило Sidekiq): обработчик перечитывает домен сам. */
  payload?: Record<string, unknown>;
  /** Отложенный запуск: до срока джоб невидим для claim'а (и бэкофф ретраев тем же полем). */
  runAt?: Date;
  /**
   * Идемпотентная постановка: uniqueKey уникален среди ЖИВЫХ (available|executing)
   * джобов типа. Повторный enqueue того же ключа — тихий no-op через INSERT ON
   * CONFLICT DO NOTHING (P2002 внутри Postgres-транзакции абортил бы ВСЮ транзакцию
   * постановщика — поэтому конфликт не должен подниматься ошибкой вообще).
   * Терминальные строки повторной постановке не мешают.
   */
  uniqueKey?: string;
  maxAttempts?: number;
  /** 0 = самый высокий (модель Oban). */
  priority?: number;
}

/** Строка, взятая в исполнение (claim): всё, что нужно воркеру. */
export interface ClaimedJob {
  id: bigint;
  type: string;
  payload: Record<string, unknown>;
  /** Попытка ПОСЛЕ инкремента клейма — клейм-токен финальных записей. */
  attempts: number;
  maxAttempts: number;
}

/**
 * Аренда, которую ставит сам claim-запрос (floor): воркер сразу после клейма
 * поднимает её до бюджета типа. Floor щедрый, чтобы reaper не украл строку в
 * зазоре между клеймом и подъёмом.
 */
const CLAIM_LEASE_FLOOR_SEC = 300;

/** Потолок текста ошибки в last_error (стектрейсы бывают огромными). */
const MAX_ERROR_LEN = 2000;

/** Размер батча ретеншна: массовый DELETE одним стейтментом душит WAL и держит индекс. */
const RETENTION_BATCH = 5000;

/**
 * Потолок строк, возвращаемых в очередь за один прогон reaper'а. Одновременно
 * `executing` может быть не больше, чем слотов у воркеров (десятки), так что это
 * страховка от патологии, а не рабочее ограничение — остаток заберёт следующая минута.
 */
const REAP_BATCH = 500;

/**
 * Время в сыром SQL движка — только через общий хелпер (правило и обоснование — в
 * shared/database/sql-time.ts). Здесь цена нарушения максимальная: claim стрелял бы
 * отложенными джобами раньше срока, reaper считал бы ВСЕ живые джобы протухшими и
 * переклеивал их (дубли исполнения), а ретраи уезжали бы на смещение пояса вперёд.
 */
const ts = utcTs;

/**
 * core/jobs — 10-й платформенный движок: фоновые джобы / transactional outbox
 * (модель Oban/River/Solid Queue). Постановка — В ТОЙ ЖЕ транзакции, что и
 * доменная мутация (enqueue(tx, …): коммит = джоб есть, откат = джоба нет);
 * исполнение at-least-once (обработчики обязаны быть идемпотентными): claim
 * пачкой FOR UPDATE SKIP LOCKED, attempts-клейм-токен (поздний зомби-врайт =
 * no-op), аренда → reaper, экспоненциальный бэкофф с джиттером, dead-letter.
 * Мульти-инстанс из коробки (SKIP LOCKED). НЕ в chokepoint.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  /** Воркер вешает сюда «пинок» поллеру очереди (нудж после enqueue). */
  private nudger: ((queue: string) => void) | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly events: EventBusService,
  ) {}

  setNudger(fn: (queue: string) => void): void {
    this.nudger = fn;
  }

  // ============================================================
  // Постановка
  // ============================================================

  /**
   * Поставить джоб. С tx — в транзакции доменной мутации (outbox: ошибка валит
   * транзакцию целиком, откат транзакции не оставляет джоба-сироту); без tx —
   * обычная постановка (упала — постановщик видит ошибку).
   */
  async enqueue(tx: Tx | null, input: EnqueueInput): Promise<void> {
    const client = tx ?? this.db;
    const def = this.registry.get(input.type);
    // Очередь — из регистрации (источник правды); тип без обработчика на этом
    // инстансе (деплой-переход) кладём в 'default', крон-фиксап поправит.
    const queue = def?.queue ?? 'default';
    const maxAttempts = input.maxAttempts ?? def?.maxAttempts ?? JOB_LIMITS.defaultMaxAttempts;
    const runAt = input.runAt ?? new Date();
    const priority = input.priority ?? 0;

    if (input.uniqueKey) {
      // Время — только через ts() (см. его комментарий): ни now(), ни голый параметр.
      // ВНИМАНИЕ: колонки перечислены руками — иначе не выразить ON CONFLICT DO NOTHING.
      // Новая NOT NULL-колонка БЕЗ DEFAULT в таблице jobs сломает именно этот путь, и
      // сломает его в середине чужих доменных транзакций (постановка идёт в них).
      // Добавляешь колонку — либо дай ей DEFAULT, либо впиши её сюда.
      const stamp = new Date();
      await client.$executeRaw`
        INSERT INTO jobs (type, queue, payload, status, priority, run_at, max_attempts, unique_key, created_at, updated_at)
        VALUES (${input.type}, ${queue}, ${JSON.stringify(input.payload ?? {})}::jsonb, 'available', ${priority}, ${ts(runAt)}, ${maxAttempts}, ${input.uniqueKey}, ${ts(stamp)}, ${ts(stamp)})
        ON CONFLICT (type, unique_key) WHERE status IN ('available', 'executing') AND unique_key IS NOT NULL DO NOTHING
      `;
    } else {
      await client.job.create({
        data: {
          type: input.type,
          queue,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          runAt,
          maxAttempts,
          priority,
        },
      });
    }
    this.scheduleNudge(queue, runAt);
  }

  /**
   * Отменить живой НЕвзятый джоб по ключу (правка/отмена отложенной работы).
   * executing не трогаем: у бегущего обработчика доменный гвард сам увидит отмену
   * сущности (модель ScheduledMessage: клейм pending→sending — второй ремень).
   */
  async cancelByUniqueKey(tx: Tx | null, type: string, uniqueKey: string): Promise<number> {
    const client = tx ?? this.db;
    const res = await client.job.updateMany({
      where: { type, uniqueKey, status: 'available' },
      data: { status: 'cancelled', finishedAt: new Date(), leaseUntil: null },
    });
    return res.count;
  }

  /**
   * Нудж поллеру: enqueue внутри транзакции не знает момента коммита, поэтому
   * пинок уходит с небольшой задержкой (некоммиченная строка невидима клейму —
   * хвост подберёт штатный поллинг). Далёкий runAt пинка не требует.
   */
  private scheduleNudge(queue: string, runAt: Date): void {
    const delay = Math.max(runAt.getTime() - Date.now(), 0) + 50;
    if (delay > JOB_LIMITS.pollIntervalMs + 50) return;
    const t = setTimeout(() => this.nudger?.(queue), delay);
    t.unref?.();
  }

  // ============================================================
  // Исполнение (примитивы воркера)
  // ============================================================

  /**
   * Взять пачку джобов в исполнение: FOR UPDATE SKIP LOCKED (стандарт индустрии —
   * конкурентные воркеры/инстансы не дерутся за строки), attempts++ атомарно с
   * клеймом (клейм-токен). CTE-форма — как у pg-boss.
   */
  async claim(queue: string, types: string[], limit: number): Promise<ClaimedJob[]> {
    if (types.length === 0 || limit <= 0) return [];
    // Время — только через ts() (см. его комментарий про пояс сессии).
    const now = new Date();
    const leaseFloor = new Date(+now + CLAIM_LEASE_FLOOR_SEC * 1000);
    const rows = await this.db.$queryRaw<
      Array<{ id: bigint; type: string; payload: unknown; attempts: number; maxAttempts: number }>
    >`
      WITH picked AS (
        SELECT id FROM jobs
        WHERE status = 'available' AND queue = ${queue} AND run_at <= ${ts(now)}
          AND type IN (${Prisma.join(types)})
        ORDER BY priority ASC, run_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs j
      SET status = 'executing', attempts = j.attempts + 1,
          lease_until = ${ts(leaseFloor)},
          updated_at = ${ts(now)}
      FROM picked
      WHERE j.id = picked.id
      RETURNING j.id, j.type, j.payload, j.attempts, j.max_attempts AS "maxAttempts"
    `;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
    }));
  }

  /**
   * Поднять аренду с floor'а клейма до бюджета типа. Гвард по клейм-токену обязателен:
   * задержавшийся setLease нашего (уже перехваченного reaper'ом) захода иначе укоротил
   * бы аренду ЧУЖОГО живого захода и подставил его под немедленный реап.
   */
  async setLease(id: bigint, attempt: number, leaseMs: number): Promise<void> {
    await this.db.job.updateMany({
      where: { id, status: 'executing', attempts: attempt },
      data: { leaseUntil: new Date(Date.now() + leaseMs) },
    });
  }

  /** Успех. Гвард по клейм-токену: перехваченный reaper'ом джоб наш поздний врайт не заденет. */
  async complete(id: bigint, attempt: number): Promise<void> {
    await this.db.job.updateMany({
      where: { id, status: 'executing', attempts: attempt },
      data: { status: 'completed', finishedAt: new Date(), leaseUntil: null },
    });
  }

  /**
   * Провал попытки: transient → available с бэкоффом; исчерпание попыток →
   * dead-letter (discarded + error-лог + событие job.discarded); JobDiscardError →
   * discarded сразу (постоянная ошибка — ретраи бессмысленны, это НЕ инцидент).
   */
  async fail(job: ClaimedJob, def: JobTypeDef | undefined, err: unknown): Promise<void> {
    const explicitDiscard = err instanceof JobDiscardError;
    const message = String(
      (err as Error)?.stack ?? (err as Error)?.message ?? err,
    ).slice(0, MAX_ERROR_LEN);

    if (explicitDiscard || job.attempts >= job.maxAttempts) {
      const res = await this.db.job.updateMany({
        where: { id: job.id, status: 'executing', attempts: job.attempts },
        data: { status: 'discarded', lastError: message, finishedAt: new Date(), leaseUntil: null },
      });
      if (res.count === 1) {
        // Терминальная компенсация потребителя (доменная строка не должна остаться
        // в промежуточном состоянии) — до логов, чтобы сбой хука был виден рядом.
        await this.runDiscardHook(def, job.payload, {
          jobId: job.id,
          attempts: job.attempts,
          error: message,
        });
        if (explicitDiscard) {
          this.logger.warn(`job ${job.id} (${job.type}) discarded by handler: ${(err as Error).message}`);
        } else {
          this.logger.error(
            `job ${job.id} (${job.type}) dead-letter after ${job.attempts} attempts: ${message}`,
          );
          this.events.emit(
            'job.discarded',
            { jobId: job.id.toString(), type: job.type, attempts: job.attempts, error: message },
            'jobs',
          );
        }
      }
      return;
    }

    const delay = this.backoffMs(job.attempts, def?.backoffBaseMs ?? JOB_LIMITS.backoffBaseMs);
    await this.db.job.updateMany({
      where: { id: job.id, status: 'executing', attempts: job.attempts },
      data: {
        status: 'available',
        runAt: new Date(Date.now() + delay),
        lastError: message,
        leaseUntil: null,
      },
    });
  }

  /** Экспоненциальный бэкофф с джиттером ±25% (толпа ретраев не бьёт в одну секунду). */
  private backoffMs(attempt: number, baseMs: number): number {
    const raw = Math.min(JOB_LIMITS.backoffCapMs, baseMs * 2 ** (Math.max(attempt, 1) - 1));
    const jitter = raw * 0.25 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(raw + jitter));
  }

  // ============================================================
  // Обслуживание (крон движка)
  // ============================================================

  /**
   * Reaper протухших аренд: краш/зависание инстанса не теряет джоб — попытка уже
   * посчитана при клейме, поэтому исчерпанные хоронятся, остальные возвращаются
   * в очередь с бэкоффом (база — дефолтная: тип строки в SQL недоступен, и это
   * путь редких аварий, а не штатных ретраев).
   */
  async reapExpired(): Promise<void> {
    // Время — только через ts() (см. его комментарий про пояс сессии).
    const now = new Date();
    const dead = await this.db.$queryRaw<
      Array<{ id: bigint; type: string; attempts: number; payload: unknown; lastError: string | null }>
    >`
      UPDATE jobs
      SET status = 'discarded', lease_until = NULL, finished_at = ${ts(now)}, updated_at = ${ts(now)},
          last_error = COALESCE(last_error, 'аренда истекла (краш инстанса?)')
      WHERE status = 'executing' AND lease_until < ${ts(now)} AND attempts >= max_attempts
      RETURNING id, type, attempts, payload, last_error AS "lastError"
    `;
    for (const j of dead) {
      this.logger.error(`job ${j.id} (${j.type}) dead-letter by reaper after ${j.attempts} attempts`);
      // Обработчик тут НЕ отработал (джоб умер по аренде) — терминальную компенсацию
      // домена может сделать только этот хук, иначе строка зависнет навсегда.
      await this.runDiscardHook(this.registry.get(j.type), (j.payload ?? {}) as Record<string, unknown>, {
        jobId: j.id,
        attempts: j.attempts,
        error: j.lastError ?? 'lease expired',
      });
      this.events.emit(
        'job.discarded',
        { jobId: j.id.toString(), type: j.type, attempts: j.attempts, error: 'lease expired' },
        'jobs',
      );
    }

    // Возврат в очередь — пер-строчно, с базой бэкоффа ТИПА и джиттером (в одном SQL
    // их взять неоткуда: раньше здесь стояла общая дефолтная база, и типы с минутной
    // базой — files.pipeline, files.scan — после аварии ретраились через 30с вместо
    // своей минуты). Строк тут единицы: одновременно executing может быть не больше,
    // чем слотов у воркеров, — поэтому цикл дешевле и точнее общего UPDATE.
    // Гвард (status, attempts) — чтобы не тронуть заход, который как раз завершается.
    const expired = await this.db.job.findMany({
      where: { status: 'executing', leaseUntil: { lt: now } },
      select: { id: true, type: true, attempts: true },
      take: REAP_BATCH,
    });
    let requeued = 0;
    for (const j of expired) {
      const base = this.registry.get(j.type)?.backoffBaseMs ?? JOB_LIMITS.backoffBaseMs;
      const res = await this.db.job.updateMany({
        where: { id: j.id, status: 'executing', attempts: j.attempts },
        data: {
          status: 'available',
          leaseUntil: null,
          runAt: new Date(Date.now() + this.backoffMs(j.attempts, base)),
        },
      });
      requeued += res.count;
    }
    if (requeued > 0) {
      this.logger.warn(`reaper requeued ${requeued} expired job(s) — instance crash or over-budget handler`);
    }
  }

  /**
   * Фиксап очередей: тип переехал в другую очередь между деплоями → available-строки
   * со старой очередью стали бы невидимы её поллеру. Регистрация — источник правды.
   */
  async fixStrandedQueues(): Promise<void> {
    for (const def of this.registry.all()) {
      const res = await this.db.job.updateMany({
        where: { type: def.type, status: 'available', queue: { not: def.queue } },
        data: { queue: def.queue },
      });
      if (res.count > 0) {
        this.logger.warn(`moved ${res.count} job(s) of type ${def.type} to queue "${def.queue}"`);
      }
    }
  }

  /**
   * Живые джобы типов БЕЗ обработчика на этом инстансе. Такая строка не исполнится
   * (claim фильтрует по реестру), не переедет (фиксап идёт по реестру) и не протухнет
   * (ретеншн трогает только терминальные) — то есть она бессмертна.
   *
   * НО удалять их автоматически НЕЛЬЗЯ: «нет обработчика» гораздо чаще значит
   * «фича выключена в этом окружении» (files.scan без CLAMAV_HOST, voice.transcribe
   * без VOICE_STT_URL, calls.recording.* без LIVEKIT_*), а не «тип удалён». Плюс при
   * раскатке нового релиза старый инстанс временно не знает новых типов — авто-чистка
   * по мнению ОДНОГО инстанса снесла бы работу, которую сосед прекрасно умеет делать.
   * Поэтому движок их ВИДИТ и НАЗЫВАЕТ (stats + часовой варн), а хоронит только
   * человек через `purgeUnhandled` — осознанно, зная, что тип действительно мёртв.
   */
  async listUnhandled(): Promise<Array<{ type: string; count: number; oldestAgeSec: number }>> {
    const known = this.registry.all().map((d) => d.type);
    const rows = await this.db.job.groupBy({
      by: ['type'],
      where: { status: { in: ['available', 'executing'] }, type: { notIn: known } },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    return rows.map((r) => ({
      type: r.type,
      count: r._count._all,
      oldestAgeSec: r._min.createdAt
        ? Math.max(0, Math.round((Date.now() - r._min.createdAt.getTime()) / 1000))
        : 0,
    }));
  }

  /** Часовой отчёт: бессмертные строки должны быть громко видны, а не копиться молча. */
  async reportUnhandled(): Promise<void> {
    const rows = await this.listUnhandled();
    for (const r of rows) {
      this.logger.warn(
        `${r.count} джоб(ов) типа "${r.type}" без обработчика на этом инстансе ` +
          `(старейшему ${Math.round(r.oldestAgeSec / 3600)}ч). Это либо выключенная фича ` +
          `(проверьте её переменные окружения), либо удалённый тип — тогда чистить ` +
          `осознанно через purgeUnhandled.`,
      );
    }
  }

  /**
   * Осознанно похоронить джобы мёртвого типа (тип удалён/переименован — работа
   * потеряла смысл). Только по ЯВНО названному типу: массового «убить всё, чего не
   * знаю» здесь нет намеренно — см. комментарий к listUnhandled. Статус `cancelled`
   * (это решение человека, а не сбой) + finishedAt, чтобы строки забрал ретеншн.
   */
  async purgeUnhandled(type: string): Promise<number> {
    if (this.registry.get(type)) {
      throw new Error(`тип "${type}" ЗАРЕГИСТРИРОВАН на этом инстансе — чистить нечего`);
    }
    // ТОЛЬКО available: `executing` не трогаем, потому что «нет обработчика ЗДЕСЬ» не
    // значит «нет нигде» — при мульти-инстансе или раскатке релиза этот джоб прямо
    // сейчас может выполнять соседний инстанс. Отменив его строку, мы бы не остановили
    // саму работу (она уже идёт), но её финальная запись молча не прошла бы по гварду
    // клейм-токена — и строка врала бы про исход. Взятые джобы вернёт в available
    // reaper по истечении аренды, и следующий вызов purge их заберёт.
    const res = await this.db.job.updateMany({
      where: { type, status: 'available' },
      data: {
        status: 'cancelled',
        finishedAt: new Date(),
        leaseUntil: null,
        lastError: 'тип джоба снят с обслуживания (purgeUnhandled)',
      },
    });
    if (res.count > 0) this.logger.warn(`purgeUnhandled: похоронено ${res.count} джоб(ов) типа "${type}"`);
    return res.count;
  }

  /**
   * Ретеншн терминальных строк — движок чистит сам (jobs_retention_idx). Батчами:
   * первый прогон после накопленного бэклога иначе снёс бы сотни тысяч строк одним
   * DELETE (WAL-всплеск, длинная блокировка индекса) — правило платформы из скейл-ревью.
   */
  async pruneTerminal(): Promise<void> {
    const completedBefore = new Date(Date.now() - JOB_LIMITS.completedRetentionDays * 86_400_000);
    const discardedBefore = new Date(Date.now() - JOB_LIMITS.discardedRetentionDays * 86_400_000);
    const prune = async (statuses: JobStatus[], before: Date): Promise<number> => {
      let total = 0;
      for (;;) {
        const batch = await this.db.job.findMany({
          where: { status: { in: statuses }, finishedAt: { lt: before } },
          select: { id: true },
          take: RETENTION_BATCH,
        });
        if (batch.length === 0) return total;
        const res = await this.db.job.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
        total += res.count;
        if (batch.length < RETENTION_BATCH) return total;
      }
    };
    const a = await prune(['completed'], completedBefore);
    const b = await prune(['discarded', 'cancelled'], discardedBefore);
    if (a + b > 0) this.logger.log(`pruned ${a} completed + ${b} discarded/cancelled job(s)`);
  }

  /**
   * Вызвать терминальный хук потребителя. Ошибка хука не должна ломать похороны джоба —
   * логируем и идём дальше (строка уже discarded, повторов не будет).
   */
  private async runDiscardHook(
    def: JobTypeDef | undefined,
    payload: Record<string, unknown>,
    info: { jobId: bigint; attempts: number; error: string },
  ): Promise<void> {
    if (!def?.onDiscard) return;
    try {
      await def.onDiscard(payload, info);
    } catch (err) {
      this.logger.error(
        `onDiscard hook for ${def.type} (job ${info.jobId}) failed: ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  // ============================================================
  // Дев-наблюдаемость
  // ============================================================

  async stats(): Promise<JobStatsDto> {
    const grouped = await this.db.job.groupBy({ by: ['type', 'status'], _count: { _all: true } });
    const oldest = await this.db.job.findFirst({
      // Только типы с обработчиком: иначе джоб выключенной фичи (ClamAV/STT/LiveKit
      // не заданы) или удалённого типа навсегда запинывал бы прибор «очередь встала».
      where: {
        status: 'available',
        runAt: { lte: new Date() },
        type: { in: this.registry.all().map((d) => d.type) },
      },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    });
    const unhandled = await this.listUnhandled();
    const recent = await this.db.job.findMany({
      where: { status: 'discarded' },
      orderBy: { finishedAt: 'desc' },
      take: 20,
      select: { id: true, type: true, attempts: true, lastError: true, finishedAt: true },
    });
    return {
      counts: grouped.map((g) => ({
        type: g.type,
        status: g.status as JobStatus,
        count: g._count._all,
      })),
      oldestAvailableAgeSec: oldest
        ? Math.max(0, Math.round((Date.now() - oldest.runAt.getTime()) / 1000))
        : null,
      unhandled,
      recentDiscarded: recent.map((r) => ({
        id: r.id.toString(),
        type: r.type,
        attempts: r.attempts,
        lastError: r.lastError,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      })),
    };
  }
}
