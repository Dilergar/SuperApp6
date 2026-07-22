/**
 * core/jobs — движок фоновых джобов (10-й платформенный), transactional outbox.
 *
 * Джоб ставится в ТОЙ ЖЕ транзакции, что и доменная мутация (enqueue(tx, …)):
 * коммит = джоб есть, откат = джоба нет. Исполнение at-least-once — обработчики
 * обязаны быть идемпотентными. Статусы: available | executing | completed |
 * discarded | cancelled («retryable» видно по attempts>0, «scheduled» — по runAt>now).
 *
 * Здесь — дефолты исполнения; per-type переопределения задаются при регистрации
 * обработчика (JobsRegistry.register).
 */
export const JOB_LIMITS = {
  /** Попыток до dead-letter (discarded) по умолчанию; per-type/per-job override. */
  defaultMaxAttempts: 5,
  /**
   * Аренда исполнения по умолчанию (мс): протухла у executing → reaper вернёт джоб
   * в очередь (попытка уже посчитана при клейме). Длинные типы задают свой бюджет
   * (модель бюджета STT у core/voice).
   */
  defaultLeaseMs: 60_000,
  /** Экспоненциальный бэкофф ретраев: base × 2^(attempt−1), джиттер ±25%, кап. */
  backoffBaseMs: 30_000,
  backoffCapMs: 3_600_000,
  /** Поллер очереди: пауза между проходами (нудж после enqueue будит раньше). */
  pollIntervalMs: 1000,
  /** Максимум джобов одним SKIP LOCKED-клеймом (и не больше свободных слотов). */
  claimBatch: 10,
  /** Конкурентность очереди по умолчанию (слотов на инстанс). */
  defaultQueueConcurrency: 10,
  /** Ретеншн терминальных строк — движок чистит сам (completed / discarded+cancelled). */
  completedRetentionDays: 7,
  discardedRetentionDays: 30,
  /** Дренаж при остановке инстанса: сколько ждать in-flight джобы (мс). */
  shutdownDrainMs: 10_000,
} as const;

export const JOB_STATUSES = [
  'available',
  'executing',
  'completed',
  'discarded',
  'cancelled',
] as const;
