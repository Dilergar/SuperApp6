import { APP_TIMEZONE } from '@superapp/shared';

/**
 * Окно действия назначения (StaffAssignment).
 *
 * Назначение ДАТИРОВАНО с сервиса «Объекты»: человек уходит и возвращается на ту же
 * позицию — это разные строки, а закрытая остаётся в истории (на неё ссылаются
 * ставки и смены). Поэтому КАЖДЫЙ потребитель «кто сейчас работает» обязан
 * фильтровать по датам: иначе истёкшее назначение продолжает давать права,
 * подставляться в документы и считаться в ростере.
 *
 * Границы включительные: `startsOn <= at <= endsOn`; null — «без границы».
 */
export interface AssignmentWindow {
  startsOn: Date | string | null;
  endsOn: Date | string | null;
}

/** Сегодня в поясе платформы (YYYY-MM-DD) — та же база, что у orgToday(). */
export function assignmentToday(timeZone: string = APP_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function dateStr(v: Date | string | null): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

/** Действует ли назначение на дату `at` (YYYY-MM-DD). */
export function isAssignmentActiveOn(a: AssignmentWindow, at: string): boolean {
  const from = dateStr(a.startsOn);
  const to = dateStr(a.endsOn);
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

/**
 * Prisma-фрагмент «действует на дату» для выборок назначений.
 * Кладётся в `where` рядом с workspaceId: `where: { workspaceId, ...activeAssignmentWhere() }`.
 */
export function activeAssignmentWhere(at: string = assignmentToday()): {
  AND: [
    { OR: [{ startsOn: null }, { startsOn: { lte: Date } }] },
    { OR: [{ endsOn: null }, { endsOn: { gte: Date } }] },
  ];
} {
  const day = new Date(`${at}T00:00:00.000Z`);
  return {
    AND: [
      { OR: [{ startsOn: null }, { startsOn: { lte: day } }] },
      { OR: [{ endsOn: null }, { endsOn: { gte: day } }] },
    ],
  };
}

/**
 * Пересечение периодов назначения (EXCLUDE `staff_assignments_no_overlap`).
 * Prisma отдаёт 23P01 сырым `PrismaClientUnknownRequestError` — распознаём по коду
 * в тексте: это ЕДИНСТВЕННОЕ EXCLUDE-ограничение на таблице.
 */
export function isAssignmentOverlapError(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? '';
  return msg.includes('23P01') || msg.includes('staff_assignments_no_overlap');
}
