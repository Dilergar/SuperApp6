// ============================================================
// CALENDAR — constants (presets, palette, limits)
// ============================================================

import type {
  CalendarEventVisibility,
  CalendarAccessLevel,
  RsvpStatus,
  ResourceType,
  ResourceBookingStatus,
} from '../types/calendar';

// Per-event privacy override options (semantics wired in Phase 2).
export const EVENT_VISIBILITY_OPTIONS: Array<{
  value: CalendarEventVisibility;
  label: string;
  hint: string;
}> = [
  { value: 'inherit', label: 'Как настроено', hint: 'По правилам доступа Групп/людей' },
  { value: 'busy', label: 'Только «Занят»', hint: 'Видно занятость, без деталей' },
  { value: 'hidden', label: 'Скрыто', hint: 'Не видит никто, даже занятость' },
];

// Calendar access scale (Phase 2): how much of your calendar a viewer sees.
export const CALENDAR_ACCESS_LEVELS: readonly CalendarAccessLevel[] = [
  'none',
  'busy',
  'detailed',
] as const;

export const CALENDAR_ACCESS_LEVEL_META: Record<
  CalendarAccessLevel,
  { label: string; rank: number; hint: string }
> = {
  none: { label: 'Нет доступа', rank: 0, hint: 'Не видит твой календарь' },
  busy: { label: 'Только «Занят»', rank: 1, hint: 'Видит занятость без деталей' },
  detailed: { label: 'Детально', rank: 2, hint: 'Видит все события целиком' },
};

/** Default access for someone not granted anything (private-by-default). */
export const DEFAULT_CALENDAR_ACCESS: CalendarAccessLevel = 'none';

// Recurrence presets — `rule` is the RRULE stored on the event.
export const CALENDAR_RECURRENCE_PRESETS: Array<{ label: string; rule: string | null }> = [
  { label: 'Не повторять', rule: null },
  { label: 'Ежедневно', rule: 'FREQ=DAILY' },
  { label: 'По будням', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Еженедельно', rule: 'FREQ=WEEKLY' },
  { label: 'Каждые 2 недели', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { label: 'Ежемесячно', rule: 'FREQ=MONTHLY' },
  { label: 'Ежегодно', rule: 'FREQ=YEARLY' },
];

// Reminder presets — minutes before the event start.
export const CALENDAR_REMINDER_PRESETS: Array<{ label: string; minutesBefore: number }> = [
  { label: 'В момент начала', minutesBefore: 0 },
  { label: 'За 10 минут', minutesBefore: 10 },
  { label: 'За 30 минут', minutesBefore: 30 },
  { label: 'За 1 час', minutesBefore: 60 },
  { label: 'За 2 часа', minutesBefore: 120 },
  { label: 'За 1 день', minutesBefore: 1440 },
  { label: 'За 2 дня', minutesBefore: 2880 },
  { label: 'За неделю', minutesBefore: 10080 },
];

/** Defaults applied to new events (ТЗ: за 24ч и за 30мин). */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [1440, 30];

// Sketchbook palette for events (DESIGN.md aesthetic).
export const CALENDAR_EVENT_COLORS: Array<{ name: string; value: string }> = [
  { name: 'Восковой красный', value: '#c61a1e' },
  { name: 'Голубой карандаш', value: '#326a8b' },
  { name: 'Охра', value: '#d97706' },
  { name: 'Зелёный мел', value: '#16a34a' },
  { name: 'Слива', value: '#7c3aed' },
  { name: 'Графит', value: '#475569' },
];

export const DEFAULT_EVENT_COLOR = '#326a8b';

export const CALENDAR_LIMITS = {
  maxTitleLength: 500,
  maxDescriptionLength: 5000,
  maxLocationLength: 500,
  maxReminders: 5,
  maxReminderMinutes: 40320, // 4 weeks
  /** max span (days) a single range query may cover. */
  rangeMaxDays: 366,
  /** rolling horizon (days) for which reminders are materialized. */
  reminderHorizonDays: 35,
  /** safety cap on occurrences expanded from a single recurring event per range. */
  maxOccurrencesPerEvent: 750,
} as const;

/** Week starts on Monday (KZ/RU convention). 1 = Monday, per date-fns weekStartsOn. */
export const WEEK_STARTS_ON = 1;

/** Default new-event duration in minutes. */
export const DEFAULT_EVENT_DURATION_MIN = 60;

// ---- Phase 2 (social) ----

export const RSVP_META: Record<
  RsvpStatus,
  { label: string; group: string; color: string; icon: string }
> = {
  pending: { label: 'Не ответил', group: 'Не ответили', color: '#9ca3af', icon: '○' },
  accepted: { label: 'Приду', group: 'Придут', color: '#16a34a', icon: '✓' },
  declined: { label: 'Не приду', group: 'Не придут', color: '#c61a1e', icon: '✕' },
  tentative: { label: 'Может быть', group: 'Думают', color: '#d97706', icon: '?' },
};

/** Smart Match defaults: working window + slot granularity. */
export const SMART_MATCH_DEFAULTS = {
  dayStartMin: 9 * 60, // 09:00
  dayEndMin: 21 * 60, // 21:00
  slotStepMin: 30,
  maxSlots: 30,
} as const;

export const SMART_MATCH_DURATIONS: Array<{ label: string; min: number }> = [
  { label: '30 минут', min: 30 },
  { label: '1 час', min: 60 },
  { label: '1,5 часа', min: 90 },
  { label: '2 часа', min: 120 },
];

// ---- Phase 3 (resources) ----

export const RESOURCE_TYPE_META: Record<ResourceType, { label: string; icon: string }> = {
  room: { label: 'Помещение', icon: '🚪' },
  vehicle: { label: 'Транспорт', icon: '🚗' },
  equipment: { label: 'Оборудование', icon: '🔧' },
  other: { label: 'Другое', icon: '📦' },
};

export const RESOURCE_BOOKING_STATUS_META: Record<
  ResourceBookingStatus,
  { label: string; color: string }
> = {
  pending: { label: 'Ожидает подтверждения', color: '#d97706' },
  confirmed: { label: 'Подтверждена', color: '#16a34a' },
  rejected: { label: 'Отклонена', color: '#c61a1e' },
};
