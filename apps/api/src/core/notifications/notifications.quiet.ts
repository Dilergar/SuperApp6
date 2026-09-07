import type { NotificationQuietRule } from '@superapp/shared';

/**
 * Тишина = личное расписание по дням (в поясе человека) + разовая пауза.
 * Чистые функции без БД: фанаут считает их пачкой на адресатов, ручка — для одного.
 */

export interface QuietState {
  quiet: boolean;
  /** Когда тишина кончится (для runAt отложенного push); null — не тихо */
  until: Date | null;
}

interface LocalClock {
  /** 1 = понедельник … 7 = воскресенье (ISO) */
  isoDay: number;
  minutes: number;
  /** Смещение пояса в минутах относительно UTC в момент `now` */
  offsetMin: number;
  year: number;
  month: number;
  day: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        weekday: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      });
    } catch {
      // Неизвестный пояс в профиле (строка из прошлой эпохи) — пояс продукта
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Almaty',
        hourCycle: 'h23',
        weekday: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      });
    }
    partsCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Местное время человека в его поясе. */
export function localClock(now: Date, timeZone: string): LocalClock {
  const parts = formatter(timeZone).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, now.getUTCSeconds());
  const offsetMin = Math.round((asUtc - now.getTime()) / 60_000);
  return { isoDay: WEEKDAYS[get('weekday')] ?? 1, minutes: hour * 60 + minute, offsetMin, year, month, day };
}

/** Местная дата+минуты → момент UTC (смещение берём текущее: у рынка нет DST). */
function localToUtc(clock: LocalClock, dayShift: number, minutes: number): Date {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ms = Date.UTC(clock.year, clock.month - 1, clock.day + dayShift, h, m, 0) - clock.offsetMin * 60_000;
  return new Date(ms);
}

function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Тихо ли сейчас по расписанию. Окно «22:00 → 08:00» переходит через полночь:
 * оно принадлежит дню НАЧАЛА (правило «и в выходные целиком» = окно 00:00→24:00 на сб/вс).
 */
export function quietBySchedule(schedule: NotificationQuietRule[] | null | undefined, now: Date, timeZone: string): QuietState {
  if (!schedule || schedule.length === 0) return { quiet: false, until: null };
  const clock = localClock(now, timeZone);
  const prevDay = clock.isoDay === 1 ? 7 : clock.isoDay - 1;
  let until: Date | null = null;

  for (const rule of schedule) {
    const from = hhmmToMinutes(rule.from);
    const to = hhmmToMinutes(rule.to);
    const overnight = to <= from; // 22:00→08:00 или 00:00→00:00 (сутки целиком)
    if (!overnight) {
      if (rule.days.includes(clock.isoDay) && clock.minutes >= from && clock.minutes < to) {
        const end = localToUtc(clock, 0, to);
        if (!until || end > until) until = end;
      }
      continue;
    }
    const wholeDay = to === from;
    // Сегодня после `from` — окно началось сегодня
    if (rule.days.includes(clock.isoDay) && clock.minutes >= from) {
      const end = localToUtc(clock, 1, wholeDay ? from : to);
      if (!until || end > until) until = end;
    }
    // До `to` — окно началось вчера
    if (rule.days.includes(prevDay) && clock.minutes < (wholeDay ? 24 * 60 : to)) {
      const end = localToUtc(clock, 0, wholeDay ? from : to);
      if (wholeDay) {
        // вчерашние «сутки целиком» кончаются сегодня в `from` (00:00 → уже прошло, если from=0)
        if (end > now && (!until || end > until)) until = end;
      } else if (!until || end > until) until = end;
    }
  }
  if (until && until > now) return { quiet: true, until };
  return { quiet: false, until: null };
}

/** Тишина с учётом разовой паузы (пауза — тоже тишина; действует до `pausedUntil`). */
export function quietState(
  settings: { quietSchedule?: unknown; pausedUntil?: Date | null } | null | undefined,
  now: Date,
  timeZone: string,
): QuietState {
  const paused = settings?.pausedUntil && settings.pausedUntil > now ? settings.pausedUntil : null;
  const bySchedule = quietBySchedule(
    Array.isArray(settings?.quietSchedule) ? (settings!.quietSchedule as NotificationQuietRule[]) : null,
    now,
    timeZone,
  );
  if (!paused && !bySchedule.quiet) return { quiet: false, until: null };
  const candidates = [paused, bySchedule.until].filter((d): d is Date => !!d);
  const until = candidates.reduce((a, b) => (a > b ? a : b));
  // Расписание, начинающееся ВНУТРИ паузы, продлевает тишину — пересчитаем на её конце
  const chained = quietBySchedule(
    Array.isArray(settings?.quietSchedule) ? (settings!.quietSchedule as NotificationQuietRule[]) : null,
    until,
    timeZone,
  );
  return { quiet: true, until: chained.quiet && chained.until && chained.until > until ? chained.until : until };
}

/** Ближайшее «утро» — 08:00 в поясе человека (сегодня, если ещё не наступило, иначе завтра). */
export function nextMorning(now: Date, timeZone: string): Date {
  const clock = localClock(now, timeZone);
  const morning = 8 * 60;
  return clock.minutes < morning ? localToUtc(clock, 0, morning) : localToUtc(clock, 1, morning);
}
