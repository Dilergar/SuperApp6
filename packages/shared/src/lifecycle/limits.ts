// Пределы принуждения сроков (core/lifecycle): окно массового ретеншна, AIMD пачек раннера,
// кэп «радиуса поражения», пороги здоровья БД, loose FK. Одна правда для раннера, дашборда
// «Данные» (Э5) и сьютов — числа в коде раннера не дублируются.

/**
 * Окно массового ретеншна: часы по Алматы, [startHour; endHour). Вне окна прогон ретеншна
 * откладывается до следующего открытия; стирание субъекта и каскад организации идут в
 * любое время (обещание человеку и суд не ждут ночи).
 */
export const LIFECYCLE_PURGE_WINDOW = { timeZone: 'Asia/Almaty', startHour: 1, endHour: 6 } as const;

export const LIFECYCLE_LIMITS = {
  /** AIMD пачки раннера: цель по времени одной пачки (мс), старт, пол, потолок, шаги */
  batchTargetMs: 250,
  batchStart: 500,
  batchMin: 50,
  batchMax: 5000,
  batchGrow: 1.1,
  batchShrink: 0.5,
  /** Таймауты одной пачки (SET LOCAL): замок и оператор */
  batchLockTimeoutMs: 1000,
  batchStatementTimeoutMs: 5000,
  /** Подряд отказов пачки по таймауту — дальше пауза, а не долбёжка */
  batchTimeoutStreak: 5,
  /** Бюджет одного захода джоба (мс); остаток — следующим заходом того же прогона */
  jobBudgetMs: 240_000,
  /** Пауза продолжения после исчерпанного бюджета */
  continueDelayMs: 1_000,
  /** Пауза при плохом здоровье БД или серии таймаутов */
  healthSnoozeMs: 600_000,
  /** Пороги здоровья: выше — пачки ждут (GitLab/Atlassian: purge не имеет права ронять прод) */
  health: {
    replicationLagSec: 10,
    walBytesPerSec: 64 * 1024 * 1024,
    lockWaiters: 20,
    eventLoopP99Ms: 200,
  },
  /** Кэп радиуса: строк за один прогон политики; хвост — следующей ночью */
  maxRowsPerRun: 2_000_000,
  /**
   * Подозрительный объём: ожидание прогона больше доли живых строк таблицы (и больше
   * `minSuspiciousRows`) — прогон НЕ стартует до подтверждения человеком. Так ловится
   * сломанный срок/часы/фильтр до удаления, а не после (Atlassian 2022, Google/UniSuper 2024).
   */
  suspiciousShare: 0.5,
  minSuspiciousRows: 10_000,
  /** Факт превысил ожидание больше чем на долю (+ одна максимальная пачка) → стоп + тревога */
  overrunShare: 0.2,
  /** Организаций за ночь ретеншна архива; больше к удалению разом → стоп до подтверждения */
  tenantPurgesPerRun: 25,
  tenantPurgeHaltAbove: 200,
  /** Loose FK: строк учёта за проход, бюджет прохода (мс), пачка удаления детей, пауза «ребёнок под заморозкой» */
  looseFkBatch: 500,
  looseFkBudgetMs: 30_000,
  looseFkChildBatch: 1000,
  looseFkHeldRetryMs: 24 * 3600_000,
} as const;

/** Типы джобов движка (очередь `LIFECYCLE_QUEUE`). */
export const LIFECYCLE_JOBS = {
  /** Прогон срока одной политики батчами (`{ policyId, runId }`) */
  purge: 'lifecycle.purge',
  /** Каскад окончательного удаления одной организации (`{ workspaceId, runId }`) */
  tenantPurge: 'lifecycle.tenant-purge',
  /** Разбор учёта удалений без внешних ключей (`lifecycle_deleted_rows`) */
  looseFk: 'lifecycle.loose-fk',
} as const;

export const LIFECYCLE_QUEUE = 'lifecycle';

/** Статусы прогона `lifecycle_runs`. */
export const LIFECYCLE_RUN_STATUSES = ['running', 'done', 'stopped', 'failed'] as const;
export type LifecycleRunStatus = (typeof LIFECYCLE_RUN_STATUSES)[number];

/** Причины остановки прогона (коды — в отчёт, журнал и дашборд). */
export const LIFECYCLE_STOP_REASONS = ['paused', 'blast_radius', 'overrun', 'max_rows', 'handler_missing', 'cancelled', 'held'] as const;
export type LifecycleStopReason = (typeof LIFECYCLE_STOP_REASONS)[number];

/** Виды прогонов `lifecycle_runs.kind`. */
export const LIFECYCLE_RUN_KINDS = ['purge', 'tenant_purge', 'loose_fk'] as const;
export type LifecycleRunKind = (typeof LIFECYCLE_RUN_KINDS)[number];
