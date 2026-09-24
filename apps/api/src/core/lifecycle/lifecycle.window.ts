import { LIFECYCLE_PURGE_WINDOW } from '@superapp/shared';

// Окно массового ретеншна по местному времени (plan §6.1). Части даты — машинные, для
// арифметики, не для человека: латинские цифры фиксирует локаль форматтера.
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: LIFECYCLE_PURGE_WINDOW.timeZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function localParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** Сейчас внутри окна массового ретеншна. */
export function inPurgeWindow(now = new Date()): boolean {
  const { hour } = localParts(now);
  return hour >= LIFECYCLE_PURGE_WINDOW.startHour && hour < LIFECYCLE_PURGE_WINDOW.endHour;
}

/** Сколько ждать до открытия окна (0 — открыто). Минимум секунда — снуз джоба не бывает нулевым. */
export function msUntilPurgeWindow(now = new Date()): number {
  if (inPurgeWindow(now)) return 0;
  const { hour, minute, second } = localParts(now);
  const nowSec = hour * 3600 + minute * 60 + second;
  const startSec = LIFECYCLE_PURGE_WINDOW.startHour * 3600;
  const waitSec = (startSec - nowSec + 86_400) % 86_400;
  return Math.max(1000, waitSec * 1000);
}

/** Местная дата (YYYY-MM-DD) — ключ «один прогон политики за ночь». */
export function purgeLocalDay(now = new Date()): string {
  const { year, month, day } = localParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
