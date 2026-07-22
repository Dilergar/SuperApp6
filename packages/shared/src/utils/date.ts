/**
 * Часовой пояс продукта (рынок — Казахстан; совпадает с дефолтом users.timezone).
 * Используется там, где строку даты нужно ЗАФИКСИРОВАТЬ детерминированно (не по
 * TZ окружения сервера) — например, «было → стало» срока в вечных записях хроники.
 */
export const APP_TIMEZONE = 'Asia/Almaty';

/**
 * Дедлайн задачи в строку для хроники/плашек — ДЕТЕРМИНИРОВАННО в APP_TIMEZONE
 * (иначе прод-сервер в UTC зафиксировал бы дату на день раньше для пользователей
 * UTC+5..+6). Для задач «на весь день» — только дата; иначе дата + время (чтобы
 * перенос времени в пределах одного дня тоже давал запись «было → стало»).
 */
export function formatTaskDeadline(date: Date, allDay: boolean): string {
  const datePart = new Intl.DateTimeFormat('ru-RU', {
    timeZone: APP_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
  if (allDay) return datePart;
  const timePart = new Intl.DateTimeFormat('ru-RU', {
    timeZone: APP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${datePart} ${timePart}`;
}

/**
 * Get relative time string in Russian
 */
export function getRelativeTime(date: string | Date): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now.getTime() - target.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  if (diffHours < 24) return `${diffHours} ч назад`;
  if (diffDays < 7) return `${diffDays} дн назад`;

  return target.toLocaleDateString('ru-RU');
}

/**
 * Check if date is today
 */
export function isToday(date: string | Date): boolean {
  const d = new Date(date);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/**
 * Check if date is overdue
 */
export function isOverdue(date: string | Date): boolean {
  return new Date(date) < new Date();
}

/**
 * Format date range for calendar
 */
export function formatDateRange(start: string | Date, end: string | Date, allDay: boolean): string {
  const s = new Date(start);
  const e = new Date(end);

  if (allDay) {
    if (s.toDateString() === e.toDateString()) {
      return s.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    }
    return `${s.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — ${e.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
  }

  const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (s.toDateString() === e.toDateString()) {
    return `${s.toLocaleTimeString('ru-RU', timeOpts)} — ${e.toLocaleTimeString('ru-RU', timeOpts)}`;
  }
  return `${s.toLocaleDateString('ru-RU')} ${s.toLocaleTimeString('ru-RU', timeOpts)} — ${e.toLocaleDateString('ru-RU')} ${e.toLocaleTimeString('ru-RU', timeOpts)}`;
}
