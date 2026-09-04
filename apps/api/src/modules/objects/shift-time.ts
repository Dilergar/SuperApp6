// ============================================================
// Время смен — ЧИСТЫЕ функции (без БД и Nest): перевод «локальный день + минуты»
// в момент UTC в поясе ОБЪЕКТА, развёртка ротации и проверка межсменного отдыха.
//
// Почему пояс объекта, а не организации: сеть держит точки в разных зонах, и
// «сегодня» у точки в Актау наступает раньше, чем у бэк-офиса в Алматы. Смена
// через полночь нормальна — её `localDate` = день НАЧАЛА.
// ============================================================

/** Смещение пояса (мс) в конкретный момент времени. */
function offsetMsAt(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - at.getTime();
}

/**
 * «Локальный день + минуты от полуночи» → момент UTC.
 * Двухшаговое приближение переживает переход на летнее время: смещение берётся
 * уже В ОКРЕСТНОСТИ искомого момента, а не в полночь UTC.
 */
export function localToUtc(timeZone: string, localDate: string, minutes: number): Date {
  const naive = Date.UTC(
    Number(localDate.slice(0, 4)),
    Number(localDate.slice(5, 7)) - 1,
    Number(localDate.slice(8, 10)),
    0,
    minutes,
  );
  const first = new Date(naive - offsetMsAt(timeZone, new Date(naive)));
  return new Date(naive - offsetMsAt(timeZone, first));
}

/** Момент UTC → локальный день объекта (YYYY-MM-DD). */
export function utcToLocalDate(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Минуты от полуночи локального дня. */
export function utcToLocalMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** Прибавить дни к ISO-дате (без часовых поясов — календарная арифметика). */
export function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Разница в днях между ISO-датами (b − a). */
export function diffDays(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00.000Z`).getTime() - new Date(`${a}T00:00:00.000Z`).getTime();
  return Math.round(ms / 86_400_000);
}

export interface PatternSlot {
  localDate: string;
  /** Индекс дня в цикле — вместе с датой даёт идемпотентный ключ генерации */
  slot: number;
  templateId: string;
}

/**
 * Развернуть ротацию в слоты на период. Цикл — массив «шаблон или выходной»:
 * `[a, a, null, null]` = 2/2. Якорная дата задаёт фазу цикла.
 */
export function expandPattern(
  pattern: {
    anchorDate: string;
    cycle: (string | null)[];
    activeFrom: string;
    activeTo: string | null;
  },
  from: string,
  to: string,
): PatternSlot[] {
  const out: PatternSlot[] = [];
  if (pattern.cycle.length === 0) return out;
  const start = from > pattern.activeFrom ? from : pattern.activeFrom;
  const end = pattern.activeTo && pattern.activeTo < to ? pattern.activeTo : to;
  if (start > end) return out;

  const len = pattern.cycle.length;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    // Отрицательный сдвиг (день раньше якоря) обязан давать индекс из [0, len).
    const idx = ((diffDays(pattern.anchorDate, day) % len) + len) % len;
    const templateId = pattern.cycle[idx];
    if (templateId) out.push({ localDate: day, slot: idx, templateId });
  }
  return out;
}

export interface RestCheckShift {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface RestViolation {
  kind: 'rest' | 'overlap';
  /** Сколько минут отдыха получилось (для kind='rest') */
  restMin?: number;
  conflictShiftId: string;
}

/**
 * Проверить межсменный отдых и пересечения относительно уже стоящих смен.
 * Пересечение отдельно от отдыха: у него другой текст ошибки и его нельзя
 * обойти `force` — это ошибка данных, а не послабление правила.
 */
export function checkRest(
  candidate: { startsAt: Date; endsAt: Date },
  others: RestCheckShift[],
  minRestMin: number,
): RestViolation | null {
  for (const o of others) {
    const overlaps = candidate.startsAt < o.endsAt && o.startsAt < candidate.endsAt;
    if (overlaps) return { kind: 'overlap', conflictShiftId: o.id };
  }
  if (minRestMin <= 0) return null;
  for (const o of others) {
    const gapBefore = (candidate.startsAt.getTime() - o.endsAt.getTime()) / 60_000;
    const gapAfter = (o.startsAt.getTime() - candidate.endsAt.getTime()) / 60_000;
    const gap = gapBefore >= 0 ? gapBefore : gapAfter;
    if (gap >= 0 && gap < minRestMin) {
      return { kind: 'rest', restMin: Math.floor(gap), conflictShiftId: o.id };
    }
  }
  return null;
}

/** Понедельник недели, содержащей дату (ISO-неделя, weekStartsOn=1). */
export function weekStartOf(dateISO: string, weekStartsOn = 1): string {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0=вс
  const delta = (dow - weekStartsOn + 7) % 7;
  return addDays(dateISO, -delta);
}
