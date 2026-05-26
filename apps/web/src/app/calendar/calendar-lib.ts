// Date helpers + item utilities for the calendar UI.
// All display is in the browser's local timezone ("each sees in their own tz").

import {
  DEFAULT_EVENT_COLOR,
  TASK_PRIORITY_META,
  type CalendarItem,
  type CalendarEventOccurrence,
  type CalendarTaskItem,
} from '@superapp/shared';

export type CalendarView = 'month' | 'week' | 'day' | 'agenda';

export const HOUR_PX = 46; // height of one hour row in week/day grid

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
export const endOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const addMonths = (d: Date, n: number) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
};
/** Monday-based start of week. */
export const startOfWeek = (d: Date) => {
  const x = startOfDay(d);
  const wd = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(x, -wd);
};
export const startOfMonth = (d: Date) => {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
};
export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isToday = (d: Date) => sameDay(d, new Date());
export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Inclusive date range fetched/shown for a given view + anchor date. */
export function rangeForView(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === 'month') {
    const from = startOfWeek(startOfMonth(anchor));
    return { from, to: endOfDay(addDays(from, 41)) }; // 6 weeks
  }
  if (view === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: endOfDay(addDays(from, 6)) };
  }
  if (view === 'day') {
    return { from: startOfDay(anchor), to: endOfDay(anchor) };
  }
  // agenda — next 30 days
  const from = startOfDay(anchor);
  return { from, to: endOfDay(addDays(from, 30)) };
}

export function viewLabel(view: CalendarView, anchor: Date): string {
  if (view === 'month') {
    return cap(anchor.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }));
  }
  if (view === 'week') {
    const s = startOfWeek(anchor);
    const e = addDays(s, 6);
    const sM = s.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    const eM = e.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return `${sM} – ${eM}`;
  }
  if (view === 'day') {
    return cap(anchor.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
  }
  return 'Ближайшие 30 дней';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export const fmtDayHeader = (d: Date) => ({
  weekday: cap(d.toLocaleDateString('ru-RU', { weekday: 'short' })),
  day: d.getDate(),
});

export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// ---- item helpers ----

export const isEvent = (i: CalendarItem): i is CalendarEventOccurrence => i.kind === 'event';
export const isTask = (i: CalendarItem): i is CalendarTaskItem => i.kind === 'task';

/** Is this item rendered in the all-day band (vs the hourly grid)? */
export function isAllDayItem(i: CalendarItem): boolean {
  if (isEvent(i)) return i.allDay;
  return i.allDay || i.overdue; // overdue tasks pin to today's all-day bar
}

/** Day(s) the item should appear on. Overdue tasks pin to today. */
export function itemDays(i: CalendarItem): Date[] {
  if (isTask(i)) {
    return [i.overdue ? startOfDay(new Date()) : startOfDay(new Date(i.dueDate))];
  }
  const start = startOfDay(new Date(i.start));
  const end = startOfDay(new Date(i.end));
  if (!i.allDay || sameDay(start, end)) return [start];
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function itemColor(i: CalendarItem): string {
  if (isEvent(i)) return i.color || DEFAULT_EVENT_COLOR;
  if (i.overdue) return '#c61a1e';
  return TASK_PRIORITY_META[i.priority]?.color || '#326a8b';
}

export function itemTitle(i: CalendarItem): string {
  return i.title;
}

/** Minutes from local midnight for a timed item's start. */
export function minutesFromMidnight(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

export function toInputValue(d: Date, allDay: boolean): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return allDay ? date : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputValue(val: string, allDay: boolean): Date {
  return allDay ? new Date(`${val}T00:00:00`) : new Date(val);
}

/** Round a date up to the next half hour (nice default for new events). */
export function nextHalfHour(d = new Date()): Date {
  const x = new Date(d);
  x.setSeconds(0, 0);
  x.setMinutes(x.getMinutes() > 30 ? 60 : 30);
  return x;
}

export { DAY_MS };
