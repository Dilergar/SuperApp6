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

export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; icon: string; color: string }
> = {
  todo: { label: 'К выполнению', icon: '○', color: '#6b7280' },
  in_progress: { label: 'В работе', icon: '◐', color: '#326a8b' },
  on_review: { label: 'На проверке', icon: '⏳', color: '#d97706' },
  done: { label: 'Готово', icon: '✓', color: '#16a34a' },
  cancelled: { label: 'Отменена', icon: '✕', color: '#9ca3af' },
};

export const TASK_PRIORITY_META: Record<
  TaskPriority,
  { label: string; color: string }
> = {
  low: { label: 'Низкий', color: '#9ca3af' },
  medium: { label: 'Средний', color: '#326a8b' },
  high: { label: 'Высокий', color: '#d97706' },
  urgent: { label: 'Срочно', color: '#c61a1e' },
};

export const PARTICIPANT_STATUS_META: Record<
  ParticipantStatus,
  { label: string; color: string }
> = {
  pending: { label: 'Не начато', color: '#9ca3af' },
  submitted: { label: 'На проверке', color: '#d97706' },
  accepted: { label: 'Принято', color: '#16a34a' },
  returned: { label: 'Возвращено', color: '#c61a1e' },
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
