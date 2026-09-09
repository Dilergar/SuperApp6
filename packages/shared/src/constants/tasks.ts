// ============================================================
// TASKS — constants (labels, limits, presets)
// ============================================================

import type {
  TaskRole,
  TaskStatus,
  TaskPriority,
  ParticipantStatus,
} from '../types/task';

/**
 * Реестр называет СМЫСЛ, каталог даёт СЛОВО. Подписи ролей, статусов и
 * приоритетов жили здесь готовыми русскими строками — то есть один язык
 * навсегда и сразу у трёх клиентов (API, веб, мобильный). Теперь клиент берёт
 * их из неймспейса `tasks`: `tasks.role.<role>`, `tasks.status.<status>`,
 * `tasks.priority.<priority>`, `tasks.participantStatus.<status>` — ключ
 * выводится из самого значения перечисления, поэтому поля `labelKey` здесь нет.
 */
export const TASK_ROLES: readonly TaskRole[] = ['executor', 'co_executor', 'observer'];

/** Роль зрителя в задаче (включая Постановщика) — порядок чипов-фильтров. */
export const VIEWER_TASK_ROLES = ['creator', 'executor', 'co_executor', 'observer'] as const;

/**
 * Семантический тон статуса — ИМЯ СМЫСЛА, а не цвет.
 *
 * Здесь раньше лежал `color: '#d6966c'` — то есть копия палитры дизайн-системы
 * внутри общего пакета. Она молча расходилась с `globals.css`: перекраска темы
 * правила CSS меняла, а эти хексы оставляла старыми. Хекс в общем пакете
 * ЗАПРЕЩЁН — общий пакет называет смысл («ждёт проверки»), а как этот смысл
 * выглядит, решает клиент: веб — матовыми тонами кита, мобильный — своими
 * токенами. Ровно тот же приём, что у значков нод «Процессов» (`icon: 'robot'`).
 */
export type StatusTone = 'accent' | 'success' | 'warning' | 'danger' | 'waiting' | 'neutral';

/** Тон статуса — общий для API, веба и мобильного (слово — в каталоге). */
export const TASK_STATUS_META: Record<TaskStatus, { tone: StatusTone }> = {
  todo: { tone: 'neutral' },
  in_progress: { tone: 'accent' },
  on_review: { tone: 'waiting' },
  done: { tone: 'success' },
  cancelled: { tone: 'neutral' },
};

export const TASK_PRIORITY_META: Record<TaskPriority, { tone: StatusTone }> = {
  low: { tone: 'neutral' },
  medium: { tone: 'accent' },
  high: { tone: 'warning' },
  urgent: { tone: 'danger' },
};

export const PARTICIPANT_STATUS_META: Record<ParticipantStatus, { tone: StatusTone }> = {
  pending: { tone: 'neutral' },
  submitted: { tone: 'waiting' },
  accepted: { tone: 'success' },
  returned: { tone: 'danger' },
};

// Recurrence presets (RRULE-light). `rule` is what gets stored on Task.recurrenceRule;
// `key` names the catalog entry `tasks.recurrence.<key>`.
export const TASK_RECURRENCE_PRESETS: Array<{ key: string; rule: string | null }> = [
  { key: 'none', rule: null },
  { key: 'daily', rule: 'FREQ=DAILY' },
  { key: 'weekdays', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { key: 'weekly', rule: 'FREQ=WEEKLY' },
  { key: 'monthly', rule: 'FREQ=MONTHLY' },
  { key: 'yearly', rule: 'FREQ=YEARLY' },
];

// Whitelist of recurrence rules accepted by the API (validated server-side).
export const ALLOWED_RECURRENCE_RULES: readonly string[] = TASK_RECURRENCE_PRESETS.map(
  (p) => p.rule,
).filter((r): r is string => r !== null);

// Reminder presets — minutes before dueDate. UI converts to an absolute reminderAt;
// `key` names the catalog entry `tasks.reminder.<key>`.
export const TASK_REMINDER_PRESETS: Array<{ key: string; minutesBefore: number | null }> = [
  { key: 'none', minutesBefore: null },
  { key: 'min10', minutesBefore: 10 },
  { key: 'min30', minutesBefore: 30 },
  { key: 'hour1', minutesBefore: 60 },
  { key: 'day1', minutesBefore: 1440 },
];

export const TASK_LIMITS = {
  maxTitleLength: 500,
  maxDescriptionLength: 5000,
  maxCoExecutors: 100,
  maxObservers: 100,
  maxTags: 20,
  maxTagLength: 50,
  // Coins are display-only intent for now; cap kept generous but bounded.
  maxCoinReward: 1_000_000,
  listPageSize: 30,
  // If a task has a dueDate but no explicit reminder, the cron warns this many hours before.
  defaultDueSoonHours: 24,
} as const;
