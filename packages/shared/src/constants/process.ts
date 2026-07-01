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

export const PROCESS_NODE_CATEGORY_LABELS: Record<string, string> = {
  trigger: 'Триггеры запуска',
  flow: 'Логика',
  people: 'Люди',
  service: 'Сервисы',
  ai: 'AI',
  integration: 'Интеграции',
};

export const PROCESS_INSTANCE_STATUS_LABELS: Record<string, string> = {
  running: 'Идёт',
  done: 'Завершён',
  cancelled: 'Отменён',
  error: 'Ошибка',
};

export const PROCESS_STEP_STATUS_LABELS: Record<string, string> = {
  active: 'В работе',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменён',
};

export const PROCESS_VERSION_STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  published: 'Опубликована',
  superseded: 'Архивная',
};

export const PROCESS_VISIBILITY_LABELS: Record<string, string> = {
  team: 'Вся команда',
  admins: 'Только админы',
};

/** Ф3: события платформы, на которые можно повесить триггер запуска процесса (workspace-скоуп резолвится сервером). */
export const PROCESS_EVENT_TYPES = [
  { value: 'workspace.invitation.accepted', label: 'Принят новый сотрудник' },
  { value: 'workspace.member.removed', label: 'Сотрудник уволен' },
  { value: 'workspace.position.assigned', label: 'Назначена должность' },
  { value: 'workspace.position.certified', label: 'Сотрудник аттестован' },
  { value: 'task.completed', label: 'Задача завершена' },
  { value: 'task.created', label: 'Создана задача' },
  { value: 'shop.order.placed', label: 'Оформлен заказ' },
  { value: 'shop.order.funded', label: 'Краудфандинг собран' },
  { value: 'shop.order.confirmed', label: 'Заказ подтверждён' },
] as const;

export const PROCESS_TRIGGER_TYPE_LABELS: Record<string, string> = {
  event: 'Событие',
  schedule: 'Расписание',
  webhook: 'Внешний вебхук',
};

/** Ф2: поведение шага при ошибке (n8n On Error). Умолчание — «Остановить процесс» (как раньше). */
export const PROCESS_ONERROR_OPTIONS = [
  { value: 'stop', label: 'Остановить процесс' },
  { value: 'continue', label: 'Продолжить (игнорировать ошибку)' },
  { value: 'errorOutput', label: 'Уйти в ветку «Ошибка»' },
] as const;
export type ProcessOnError = (typeof PROCESS_ONERROR_OPTIONS)[number]['value'];

/** Ф2: границы повторов при сбое (Retry On Fail) — только для нод внешнего I/O. */
export const PROCESS_RETRY_MAX_TRIES = 5;
export const PROCESS_RETRY_WAIT_MAX_MS = 10_000;

export const PROCESS_SCHEDULE_UNITS = [
  { value: 'hours', label: 'часов' },
  { value: 'days', label: 'дней' },
] as const;

export const PROCESS_CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  header: 'Заголовок (токен в заголовке)',
  bearer: 'Bearer-токен',
  basic: 'Логин/пароль (Basic)',
};

/** Единицы паузы (нода «Пауза»). */
export const PROCESS_DELAY_UNITS = [
  { value: 'minutes', label: 'минут' },
  { value: 'hours', label: 'часов' },
  { value: 'days', label: 'дней' },
] as const;

export const PROCESS_DELAY_UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** Операторы ноды «Если» (сравнение полей анкеты — без языка выражений). */
export const PROCESS_CONDITION_OPS = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'содержит' },
  { value: 'empty', label: 'пусто' },
  { value: 'not_empty', label: 'не пусто' },
] as const;

export type ProcessConditionOp = (typeof PROCESS_CONDITION_OPS)[number]['value'];
