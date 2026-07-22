import { Injectable, Logger } from '@nestjs/common';
import { JOB_LIMITS } from '@superapp/shared';

/** Контекст исполнения, который движок передаёт обработчику. */
export interface JobContext {
  jobId: bigint;
  /** Номер текущей попытки (1..maxAttempts) — он же клейм-токен движка. */
  attempt: number;
  maxAttempts: number;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: JobContext,
) => Promise<void>;

/**
 * Хук «джоб окончательно похоронен» (dead-letter). Нужен потому, что джоб может умереть
 * НЕ через обработчик: reaper хоронит протухшую аренду чистым SQL, и код потребителя
 * «на последней попытке пишу терминальный статус» не выполняется — доменная строка
 * навсегда осталась бы в промежуточном состоянии (processing / ingesting / pending).
 * Вызывается движком синхронно с записью discarded; ошибки хука только логируются.
 */
export type JobDiscardHook = (
  payload: Record<string, unknown>,
  info: { jobId: bigint; attempts: number; error: string },
) => Promise<void>;

export interface JobTypeOptions {
  /** Очередь concurrency (per-queue cap, модель Solid Queue). Дефолт 'default'. */
  queue?: string;
  /** Попыток до dead-letter; постановщик может переопределить per-job. */
  maxAttempts?: number;
  /**
   * Бюджет аренды исполнения (мс): протухла у executing → reaper вернёт джоб в
   * очередь (попытка уже посчитана при клейме). Длинные типы задают свой бюджет
   * (модель бюджета STT у core/voice). Обработчик обязан сам ограничивать своё
   * время этим бюджетом (таймауты внутри) — JS не умеет убить зависший Promise.
   */
  leaseMs?: number;
  /** База экспоненциального бэкоффа ретраев (мс); кап общий JOB_LIMITS.backoffCapMs. */
  backoffBaseMs?: number;
  /**
   * Слотов на инстанс для ОЧЕРЕДИ этого типа (per-queue cap, модель Solid Queue).
   * Cap очереди = MIN объявленных среди её типов; дефолт — JOB_LIMITS.defaultQueueConcurrency.
   * Тяжёлые типы (медиа-конвейер cap 3, STT cap 2) сужают конкуренцию своей очереди.
   */
  queueConcurrency?: number;
  /** Терминальная компенсация: пометить доменную строку, когда джоб похоронен. */
  onDiscard?: JobDiscardHook;
}

export interface JobTypeDef extends Required<Omit<JobTypeOptions, 'onDiscard'>> {
  type: string;
  handler: JobHandler;
  onDiscard?: JobDiscardHook;
}

/**
 * Бросить из обработчика, чтобы похоронить джоб СРАЗУ (без ретраев) — постоянная
 * ошибка: доступ отозван, сущность удалена, работа потеряла смысл. Аналог
 * Forbidden/NotFound → cancelled у отложенных сообщений.
 */
export class JobDiscardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobDiscardError';
  }
}

/**
 * Реестр обработчиков джобов (паттерн FilesRefRegistry/ChatterRefRegistry):
 * движок core/jobs не импортирует фичевые модули — потребители регистрируют
 * свой type в onModuleInit. Новый сервис с фоновой работой = +1 регистрация.
 */
@Injectable()
export class JobsRegistry {
  private readonly logger = new Logger(JobsRegistry.name);
  private readonly types = new Map<string, JobTypeDef>();

  register(type: string, handler: JobHandler, opts?: JobTypeOptions): void {
    if (this.types.has(type)) {
      this.logger.warn(`handler for "${type}" already registered — overwriting`);
    }
    // queueConcurrency валидируем: 0/отрицательное/NaN дали бы capacity<=0 и очередь
    // молча встала бы навсегда (поллер тикает, джобы не клеймятся, ни одной жалобы).
    const rawCap = opts?.queueConcurrency;
    let cap: number = JOB_LIMITS.defaultQueueConcurrency;
    if (rawCap !== undefined) {
      if (typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap >= 1) {
        cap = Math.floor(rawCap);
      } else {
        this.logger.warn(
          `queueConcurrency=${String(rawCap)} у типа "${type}" некорректен — беру ${cap}`,
        );
      }
    }
    this.types.set(type, {
      type,
      handler,
      queue: opts?.queue ?? 'default',
      maxAttempts: opts?.maxAttempts ?? JOB_LIMITS.defaultMaxAttempts,
      leaseMs: opts?.leaseMs ?? JOB_LIMITS.defaultLeaseMs,
      backoffBaseMs: opts?.backoffBaseMs ?? JOB_LIMITS.backoffBaseMs,
      queueConcurrency: cap,
      onDiscard: opts?.onDiscard,
    });
  }

  get(type: string): JobTypeDef | undefined {
    return this.types.get(type);
  }

  all(): JobTypeDef[] {
    return [...this.types.values()];
  }

  /** Очереди с зарегистрированными типами — по ним воркер поднимает поллеры. */
  queues(): string[] {
    return [...new Set(this.all().map((t) => t.queue))];
  }

  /** Типы очереди: claim берёт ТОЛЬКО известные обработчики (чужой тип не клеймится). */
  typesOf(queue: string): string[] {
    return this.all()
      .filter((t) => t.queue === queue)
      .map((t) => t.type);
  }

  /**
   * Cap конкуренции очереди на инстанс = MIN объявленных queueConcurrency среди её
   * типов. ВНИМАНИЕ: cap — свойство ОЧЕРЕДИ, а не типа: узкий тип сужает ВСЮ очередь.
   * Поэтому тяжёлым типам дают СВОЮ очередь ('media', 'voice'), а не сужают 'default'.
   */
  concurrencyOf(queue: string): number {
    const caps = this.all()
      .filter((t) => t.queue === queue)
      .map((t) => t.queueConcurrency);
    return caps.length ? Math.min(...caps) : JOB_LIMITS.defaultQueueConcurrency;
  }
}
