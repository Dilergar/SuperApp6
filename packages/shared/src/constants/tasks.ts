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
 * Подпись и цвет статуса — общие для API, веба и мобильного.
 * Значка здесь НЕТ намеренно: рисунок — дело клиента, и веб берёт иконку с тоном
 * из `TASK_STATUS_VIEW` (`app/tasks/tasks-ui.tsx`). Прежнее текстовое поле `icon`
 * («○ ◐ ⏳ ✓ ✕») читало ровно одно место и тащило эмодзи в интерфейс — убрано.
 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; color: string }
> = {
  todo: { label: 'К выполнению', color: '#8a8478' },
  in_progress: { label: 'В работе', color: '#588cd3' },
  on_review: { label: 'На проверке', color: '#d6966c' },
  done: { label: 'Готово', color: '#74a277' },
  cancelled: { label: 'Отменена', color: '#a39d92' },
};

export const TASK_PRIORITY_META: Record<
  TaskPriority,
  { label: string; color: string }
> = {
  low: { label: 'Низкий', color: '#a39d92' },
  medium: { label: 'Средний', color: '#588cd3' },
  high: { label: 'Высокий', color: '#d6966c' },
  urgent: { label: 'Срочно', color: '#de6d68' },
};

export const PARTICIPANT_STATUS_META: Record<
  ParticipantStatus,
  { label: string; color: string }
> = {
  pending: { label: 'Не начато', color: '#a39d92' },
  submitted: { label: 'На проверке', color: '#d6966c' },
  accepted: { label: 'Принято', color: '#74a277' },
  returned: { label: 'Возвращено', color: '#de6d68' },
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
