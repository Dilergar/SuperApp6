// ============================================================
// CALENDAR — constants (presets, palette, limits)
//
// Реестр называет СМЫСЛ, каталог даёт СЛОВО. Здесь раньше лежали готовые
// русские подписи — то есть один язык навсегда и сразу у трёх клиентов (API,
// веб, мобильный). Теперь каждая запись несёт КЛЮЧ (`key`/`labelKey`) либо
// выводимое из значения перечисления имя ключа, а слова живут в неймспейсе
// `calendar` (`packages/i18n/src/messages/<locale>/calendar.json`).
// ============================================================

import type {
  CalendarEventVisibility,
  CalendarAccessLevel,
  RsvpStatus,
  ResourceType,
  ResourceBookingStatus,
} from '../types/calendar';

// Per-event privacy override options (semantics wired in Phase 2).
// Слова — `calendar.visibility.<value>` и `calendar.visibility.<value>Hint`.
export const EVENT_VISIBILITY_VALUES: readonly CalendarEventVisibility[] = [
  'inherit',
  'busy',
  'hidden',
] as const;

// Calendar access scale (Phase 2): how much of your calendar a viewer sees.
export const CALENDAR_ACCESS_LEVELS: readonly CalendarAccessLevel[] = [
  'none',
  'busy',
  'detailed',
] as const;

/** Ранг уровня доступа. Слова — `calendar.access.<level>` и `…Hint`. */
export const CALENDAR_ACCESS_LEVEL_META: Record<CalendarAccessLevel, { rank: number }> = {
  none: { rank: 0 },
  busy: { rank: 1 },
  detailed: { rank: 2 },
};

/** Default access for someone not granted anything (private-by-default). */
export const DEFAULT_CALENDAR_ACCESS: CalendarAccessLevel = 'none';

// Recurrence presets — `rule` is the RRULE stored on the event, `key` names the
// catalog entry `calendar.recurrence.<key>`.
export const CALENDAR_RECURRENCE_PRESETS: Array<{ key: string; rule: string | null }> = [
  { key: 'none', rule: null },
  { key: 'daily', rule: 'FREQ=DAILY' },
  { key: 'weekdays', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { key: 'weekly', rule: 'FREQ=WEEKLY' },
  { key: 'biweekly', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { key: 'monthly', rule: 'FREQ=MONTHLY' },
  { key: 'yearly', rule: 'FREQ=YEARLY' },
];

// Reminder presets — minutes before the event start (`calendar.reminder.<key>`).
export const CALENDAR_REMINDER_PRESETS: Array<{ key: string; minutesBefore: number }> = [
  { key: 'atStart', minutesBefore: 0 },
  { key: 'min10', minutesBefore: 10 },
  { key: 'min30', minutesBefore: 30 },
  { key: 'hour1', minutesBefore: 60 },
  { key: 'hour2', minutesBefore: 120 },
  { key: 'day1', minutesBefore: 1440 },
  { key: 'day2', minutesBefore: 2880 },
  { key: 'week1', minutesBefore: 10080 },
];

/** Defaults applied to new events (ТЗ: за 24ч и за 30мин). */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [1440, 30];

// Sketchbook palette for events (DESIGN.md aesthetic). Хекс — ДАННЫЕ события
// (человек выбрал цвет сам), имя цвета — слово: `calendar.color.<key>`.
export const CALENDAR_EVENT_COLORS: Array<{ key: string; value: string }> = [
  { key: 'red', value: '#de6d68' },
  { key: 'blue', value: '#588cd3' },
  { key: 'peach', value: '#d6966c' },
  { key: 'green', value: '#74a277' },
  { key: 'plum', value: '#8a6fae' },
  { key: 'graphite', value: '#6b655e' },
];

export const DEFAULT_EVENT_COLOR = '#588cd3';

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
  /** Корзина: событие (с исключениями серии) восстанавливаемо столько дней, затем уходит навсегда */
  trashRetentionDays: 30,
  /** Событий за один проход окончательного удаления */
  purgeBatch: 200,
  /** Строк в списке корзины */
  trashPageSize: 200,
} as const;

/** Week starts on Monday (KZ/RU convention). 1 = Monday, per date-fns weekStartsOn. */
export const WEEK_STARTS_ON = 1;

/** Default new-event duration in minutes. */
export const DEFAULT_EVENT_DURATION_MIN = 60;

// ---- Phase 2 (social) ----

/**
 * Значок ответа. Слова — в каталоге: `calendar.rsvp.<status>` (мой ответ) и
 * `calendar.rsvpGroup.<status>` (заголовок группы участников).
 *
 * Поле color удалено (2026-08-01): его не читал НИКТО (веб красит RSVP
 * тонами — RSVP_TONE в EventModal), а хекс не пересекает границу shared.
 */
export const RSVP_META: Record<RsvpStatus, { icon: string }> = {
  pending: { icon: '○' },
  accepted: { icon: '✓' },
  declined: { icon: '✕' },
  tentative: { icon: '?' },
};

/** Smart Match defaults: working window + slot granularity. */
export const SMART_MATCH_DEFAULTS = {
  dayStartMin: 9 * 60, // 09:00
  dayEndMin: 21 * 60, // 21:00
  slotStepMin: 30,
  maxSlots: 30,
} as const;

export const SMART_MATCH_DURATIONS: Array<{ key: string; min: number }> = [
  { key: 'min30', min: 30 },
  { key: 'hour1', min: 60 },
  { key: 'hour1h', min: 90 },
  { key: 'hour2', min: 120 },
];

// ---- Phase 3 (resources) ----

/** Значок вида ресурса. Слово — `calendar.resourceType.<type>`. */
export const RESOURCE_TYPE_META: Record<ResourceType, { icon: string }> = {
  room: { icon: '🚪' },
  vehicle: { icon: '🚗' },
  equipment: { icon: '🔧' },
  other: { icon: '📦' },
};

/**
 * Статусы брони ресурса. Слова — `calendar.bookingStatus.<status>`.
 * color удалён (2026-08-01) — мёртвое поле, см. комментарий у RSVP_META.
 */
export const RESOURCE_BOOKING_STATUSES: readonly ResourceBookingStatus[] = [
  'pending',
  'confirmed',
  'rejected',
] as const;

// ---- Слои календаря (реестр платформы) ----

/**
 * Календарь — «розетка» экосистемы: любой сервис может показывать свои записи
 * на общей сетке отдельным слоем. Слой объявляется здесь (ярлык/иконка/тон
 * тумблера для веба — модель NOTIFICATION_REGISTRY), а данные отдаёт провайдер,
 * зарегистрированный на API в CalendarLayersRegistry (модуль-владелец данных
 * регистрирует его в onModuleInit — календарь потребителей поимённо не знает).
 * Новый слой = +1 запись здесь + +1 провайдер (+ свой kind в CalendarItem).
 * Контракт: kind элементов слоя = ключ слоя ('event'/'task' у 'events'/'tasks' —
 * легаси-исключения, новые слои называют kind ровно как ключ).
 */
export interface CalendarLayerMeta {
  /** Ключ каталога подписи тумблера (`calendar.layer.<key>`). */
  labelKey: string;
  /** Имя иконки кита для тумблера. */
  icon: string;
  /** Матовый тон чипа-тумблера. */
  tone: 'accent' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Отдаётся ли слой, когда клиент не прислал layers (старые клиенты). */
  serverDefault: boolean;
}

export const CALENDAR_LAYER_REGISTRY = {
  events: { labelKey: 'calendar.layer.events', icon: 'calendar', tone: 'accent', serverDefault: true },
  tasks: { labelKey: 'calendar.layer.tasks', icon: 'tasks', tone: 'danger', serverDefault: true },
  finance: { labelKey: 'calendar.layer.finance', icon: 'finance', tone: 'warning', serverDefault: false },
  // Смены сервиса «Объекты»: опубликованный график сотрудника ложится в его личный
  // календарь (регистрирует ВЛАДЕЛЕЦ данных — modules/objects).
  shifts: { labelKey: 'calendar.layer.shifts', icon: 'calendarCheck', tone: 'success', serverDefault: true },
} as const satisfies Record<string, CalendarLayerMeta>;

export type CalendarLayerKey = keyof typeof CALENDAR_LAYER_REGISTRY;
export const CALENDAR_LAYER_KEYS = Object.keys(CALENDAR_LAYER_REGISTRY) as CalendarLayerKey[];
