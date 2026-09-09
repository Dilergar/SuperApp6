// ============================================================
// Processes — лимиты и подписи статусов
// ============================================================

export const PROCESS_LIMITS = {
  maxNodes: 150,
  maxEdges: 300,
  maxFormFields: 30,
  /** Потолок шагов на инстанс — стоп-кран от бесконечных циклов «Если»/«Перебрать список».
   *  Поднят под Ф5 (цикл переисполняет под-ветку шагами): элементы × размер под-ветки ≤ ~2000. */
  maxStepsPerInstance: 2000,
  /** Сколько авто-нод движок проходит за один толчок (остальное доберёт крон). */
  maxAutoChain: 100,
  /**
   * Потолок ОДНОВРЕМЕННО бегущих инстансов на воркспейс — анти-runaway для триггеров
   * (петля «событие → процесс → процесс»). Авто-запуск сверх лимита тихо пропускается
   * (логируется); здоровая организация его не достигает, а лавина триггеров упирается.
   */
  maxRunningInstancesPerWorkspace: 1000,
  /** Ф3: макс. глубина вложенности под-процессов (нода «Запустить процесс») — от рекурсии. */
  maxSubprocessDepth: 5,
} as const;

// ============================================================
// Реестры Процессов несут СМЫСЛ (значения), слова живут в каталоге `processes`:
// `processes.category.<ключ>`, `.instanceStatus.<статус>`, `.stepStatus.<статус>`,
// `.versionStatus.<статус>`, `.visibility.<ключ>`, `.event.<тип>`,
// `.triggerType.<тип>`, `.credentialType.<тип>`, `.scheduleUnit.<ключ>`,
// `.delayUnit.<ключ>`, `.conditionOp.<ключ>`, `.common.onError.option.<ключ>`.
// ============================================================

export const PROCESS_NODE_CATEGORIES = ['trigger', 'flow', 'people', 'service', 'ai', 'integration'] as const;

export const PROCESS_INSTANCE_STATUSES = ['running', 'done', 'cancelled', 'error'] as const;

export const PROCESS_STEP_STATUSES = ['active', 'done', 'error', 'cancelled'] as const;

export const PROCESS_VERSION_STATUSES = ['draft', 'published', 'superseded'] as const;

export const PROCESS_VISIBILITIES = ['team', 'admins'] as const;

/** Ф3: события платформы, на которые можно повесить триггер запуска процесса (workspace-скоуп резолвится сервером). */
export const PROCESS_EVENT_TYPES = [
  'workspace.invitation.accepted',
  'workspace.member.removed',
  'workspace.position.assigned',
  'workspace.position.certified',
  'task.completed',
  'task.created',
  'shop.order.placed',
  'shop.order.funded',
  'shop.order.confirmed',
  'finance.transaction.created',
] as const;

export const PROCESS_TRIGGER_TYPES = ['event', 'schedule', 'webhook'] as const;

/** Ф2: поведение шага при ошибке (n8n On Error). Умолчание — «Остановить процесс» (как раньше). */
export const PROCESS_ONERROR_OPTIONS = ['stop', 'continue', 'errorOutput'] as const;
export type ProcessOnError = (typeof PROCESS_ONERROR_OPTIONS)[number];

/** Ф2: границы повторов при сбое (Retry On Fail) — только для нод внешнего I/O. */
export const PROCESS_RETRY_MAX_TRIES = 5;
export const PROCESS_RETRY_WAIT_MAX_MS = 10_000;

export const PROCESS_SCHEDULE_UNITS = ['hours', 'days'] as const;

export const PROCESS_CREDENTIAL_TYPES = ['header', 'bearer', 'basic'] as const;

/** Единицы паузы (нода «Пауза»). */
export const PROCESS_DELAY_UNITS = ['minutes', 'hours', 'days'] as const;

export const PROCESS_DELAY_UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** Операторы ноды «Если» (сравнение полей анкеты — без языка выражений). */
export const PROCESS_CONDITION_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'empty',
  'not_empty',
] as const;

export type ProcessConditionOp = (typeof PROCESS_CONDITION_OPS)[number];
