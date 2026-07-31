// ============================================================
// TASKS — constants (labels, limits, presets)
// ============================================================

import type {
  TaskRole,
  TaskStatus,
  TaskPriority,
  ParticipantStatus,
} from '../types/task';

/** Постановщик lives on Task.creatorId; the other three are participant roles. */
export const TASK_CREATOR_LABEL = 'Постановщик';

export const TASK_ROLE_LABELS: Record<TaskRole, string> = {
  executor: 'Исполнитель',
  co_executor: 'Соисполнитель',
  observer: 'Наблюдатель',
};

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

/** Подпись и тон статуса — общие для API, веба и мобильного. */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; tone: StatusTone }
> = {
  todo: { label: 'К выполнению', tone: 'neutral' },
  in_progress: { label: 'В работе', tone: 'accent' },
  on_review: { label: 'На проверке', tone: 'waiting' },
  done: { label: 'Готово', tone: 'success' },
  cancelled: { label: 'Отменена', tone: 'neutral' },
};

export const TASK_PRIORITY_META: Record<
  TaskPriority,
  { label: string; tone: StatusTone }
> = {
  low: { label: 'Низкий', tone: 'neutral' },
  medium: { label: 'Средний', tone: 'accent' },
  high: { label: 'Высокий', tone: 'warning' },
  urgent: { label: 'Срочно', tone: 'danger' },
};

export const PARTICIPANT_STATUS_META: Record<
  ParticipantStatus,
  { label: string; tone: StatusTone }
> = {
  pending: { label: 'Не начато', tone: 'neutral' },
  submitted: { label: 'На проверке', tone: 'waiting' },
  accepted: { label: 'Принято', tone: 'success' },
  returned: { label: 'Возвращено', tone: 'danger' },
};

// Recurrence presets (RRULE-light). `rule` is what gets stored on Task.recurrenceRule.
export const TASK_RECURRENCE_PRESETS: Array<{ label: string; rule: string | null }> = [
  { label: 'Не повторять', rule: null },
  { label: 'Ежедневно', rule: 'FREQ=DAILY' },
  { label: 'По будням', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Еженедельно', rule: 'FREQ=WEEKLY' },
  { label: 'Ежемесячно', rule: 'FREQ=MONTHLY' },
  { label: 'Ежегодно', rule: 'FREQ=YEARLY' },
];

// Whitelist of recurrence rules accepted by the API (validated server-side).
export const ALLOWED_RECURRENCE_RULES: readonly string[] = TASK_RECURRENCE_PRESETS.map(
  (p) => p.rule,
).filter((r): r is string => r !== null);

// Reminder presets — minutes before dueDate. UI converts to an absolute reminderAt.
export const TASK_REMINDER_PRESETS: Array<{ label: string; minutesBefore: number | null }> = [
  { label: 'Без напоминания', minutesBefore: null },
  { label: 'За 10 минут', minutesBefore: 10 },
  { label: 'За 30 минут', minutesBefore: 30 },
  { label: 'За 1 час', minutesBefore: 60 },
  { label: 'За 1 день', minutesBefore: 1440 },
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
