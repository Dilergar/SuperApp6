import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { HR_ERROR_CODES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';

// ============================================================
// Производственный календарь РК (КЭДО). Машиночитаемого госисточника НЕТ,
// поэтому сид живёт В КОДЕ и накатывается на бутстрапе (upsert по дате):
// перенос, изданный постановлением Правительства среди года, доезжает
// патч-сидом новой версией кода.
//
// Сид знает ЧЕТЫРЕ правила:
// 1. Праздничные дни — Закон № 267-II (нацпраздник 25 октября; государственные:
//    1–2 января, 8 марта, 15 марта (ТОЛЬКО с 2027 — закон № 306-VIII), 21–23
//    марта, 1 мая, 7 мая, 9 мая, 6 июля, 16 декабря). 30 августа ИСКЛЮЧЁН
//    с 01.07.2026 — в 2026 Дня Конституции нет вообще.
// 2. Выходные по п. 5 ст. 84 ТК — 7 января и первый день Курбан-айта
//    (плавающая дата лунного календаря).
// 3. Автоперенос при совпадении с выходным (ст. 5 Закона № 267-II) — ТОЛЬКО
//    для праздничных; 7 января и Курбан-айт НЕ переносятся. Перенос считается
//    ПРОГРАММНО из списка праздников — руками его не перечисляем.
// 4. Переносы выходных дней постановлениями Правительства — отдельные записи
//    EXTRA_DAYS (появляются патч-сидом, когда постановление издано).
// ============================================================

interface SeedDay {
  date: string; // YYYY-MM-DD
  kind: 'holiday' | 'dayoff' | 'transferred' | 'workday' | 'shortened';
  name: string;
}

/** Годы, которые сид покрывает. Расчёт срока ЗА горизонтом — честный отказ. */
export const HR_CALENDAR_YEARS: readonly number[] = [2026, 2027];

/** Государственные и национальные праздники (переносятся при совпадении с выходным) */
const HOLIDAYS: Record<number, { date: string; name: string }[]> = {
  2026: [
    { date: '2026-01-01', name: 'Новый год' },
    { date: '2026-01-02', name: 'Новый год' },
    { date: '2026-03-08', name: 'Международный женский день' },
    { date: '2026-03-21', name: 'Наурыз мейрамы' },
    { date: '2026-03-22', name: 'Наурыз мейрамы' },
    { date: '2026-03-23', name: 'Наурыз мейрамы' },
    { date: '2026-05-01', name: 'Праздник единства народа Казахстана' },
    { date: '2026-05-07', name: 'День защитника Отечества' },
    { date: '2026-05-09', name: 'День Победы' },
    { date: '2026-07-06', name: 'День столицы' },
    { date: '2026-10-25', name: 'День Республики' },
    { date: '2026-12-16', name: 'День независимости' },
  ],
  2027: [
    { date: '2027-01-01', name: 'Новый год' },
    { date: '2027-01-02', name: 'Новый год' },
    { date: '2027-03-08', name: 'Международный женский день' },
    // Первое празднование Дня Конституции 15 марта — 2027 (закон № 306-VIII)
    { date: '2027-03-15', name: 'День Конституции' },
    { date: '2027-03-21', name: 'Наурыз мейрамы' },
    { date: '2027-03-22', name: 'Наурыз мейрамы' },
    { date: '2027-03-23', name: 'Наурыз мейрамы' },
    { date: '2027-05-01', name: 'Праздник единства народа Казахстана' },
    { date: '2027-05-07', name: 'День защитника Отечества' },
    { date: '2027-05-09', name: 'День Победы' },
    { date: '2027-07-06', name: 'День столицы' },
    { date: '2027-10-25', name: 'День Республики' },
    { date: '2027-12-16', name: 'День независимости' },
  ],
};

/** Выходные по п. 5 ст. 84 ТК РК — НЕ переносятся */
const DAYOFFS: SeedDay[] = [
  { date: '2026-01-07', kind: 'dayoff', name: 'Рождество Христово' },
  { date: '2026-05-27', kind: 'dayoff', name: 'Первый день Курбан-айта' },
  { date: '2027-01-07', kind: 'dayoff', name: 'Рождество Христово' },
  // Плавающая дата лунного календаря; 2027 ≈ 16 мая (совпал с воскресеньем —
  // просто совпал, переноса у выходных п. 5 ст. 84 нет)
  { date: '2027-05-16', kind: 'dayoff', name: 'Первый день Курбан-айта' },
];

/**
 * Переносы постановлениями Правительства (правило 4). Пусто, пока постановления
 * не изданы; каждая новая запись — патч-сид новой версией кода. `workday` —
 * рабочая суббота-компенсация, `transferred` — назначенный нерабочий день.
 */
const EXTRA_DAYS: SeedDay[] = [];

function toDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function toStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(s: string, days: number): string {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toStr(d);
}
function isWeekend(s: string): boolean {
  const dow = toDate(s).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Собрать полный сид: праздники + выходные + ПРОГРАММНЫЙ автоперенос + постановления */
export function buildCalendarSeed(): SeedDay[] {
  const byDate = new Map<string, SeedDay>();
  for (const days of Object.values(HOLIDAYS)) {
    for (const h of days) byDate.set(h.date, { date: h.date, kind: 'holiday', name: h.name });
  }
  for (const d of DAYOFFS) byDate.set(d.date, d);

  // Правило 3: праздник выпал на субботу/воскресенье → СЛЕДУЮЩИЙ рабочий день
  // становится выходным (transferred). Ищем первый день, который не выходной,
  // не праздник и ещё не занят другим переносом.
  for (const days of Object.values(HOLIDAYS)) {
    for (const h of days) {
      if (!isWeekend(h.date)) continue;
      let candidate = addDays(h.date, 1);
      while (isWeekend(candidate) || byDate.has(candidate)) candidate = addDays(candidate, 1);
      byDate.set(candidate, {
        date: candidate,
        kind: 'transferred',
        name: `Перенос выходного (${h.name})`,
      });
    }
  }

  for (const d of EXTRA_DAYS) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

@Injectable()
export class HrCalendarService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HrCalendarService.name);
  /** Кэш дней на процесс: календарь меняется только патч-сидом (рестартом) */
  private cache: Map<string, string> | null = null;

  constructor(private readonly db: DatabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    const seed = buildCalendarSeed();
    let failed = 0;
    for (const day of seed) {
      // Ошибка ОДНОГО дня (гонка upsert между инстансами на старте) не имеет
      // права оборвать засев остальных: неполный календарь молча считает сроки
      // неверно, а недосчёт срока — это штраф (ст. 98 КоАП).
      try {
        await this.db.workCalendarDay.upsert({
          where: { date: toDate(day.date) },
          update: { kind: day.kind, name: day.name },
          create: { date: toDate(day.date), kind: day.kind, name: day.name },
        });
      } catch (e) {
        failed += 1;
        this.logger.error(`сид производственного календаря ${day.date}: ${(e as Error).message}`);
      }
    }
    if (failed > 0) {
      this.logger.error(`производственный календарь засеян НЕ ПОЛНОСТЬЮ: ${failed} из ${seed.length} дней`);
    }
    this.cache = null;
  }

  /** Дата покрыта засеянными годами? За горизонтом расчёт честно отказывает. */
  covered(dateStr: string): boolean {
    const year = Number(dateStr.slice(0, 4));
    return HR_CALENDAR_YEARS.includes(year);
  }

  assertCovered(dateStr: string): void {
    if (!this.covered(dateStr)) {
      throw new BadRequestException({
        message: `Производственный календарь на ${dateStr.slice(0, 4)} год не загружен — срок в рабочих днях посчитать нечем`,
        details: { code: HR_ERROR_CODES.calendarHorizon },
      });
    }
  }

  private async days(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    const rows = await this.db.workCalendarDay.findMany({ select: { date: true, kind: true } });
    this.cache = new Map(rows.map((r) => [toStr(r.date), r.kind]));
    return this.cache;
  }

  /** Рабочий ли день по производственному календарю РК */
  async isWorkDay(dateStr: string): Promise<boolean> {
    const map = await this.days();
    const kind = map.get(dateStr);
    if (kind === 'workday' || kind === 'shortened') return true;
    if (kind === 'holiday' || kind === 'dayoff' || kind === 'transferred') return false;
    return !isWeekend(dateStr);
  }

  /**
   * Дата через N РАБОЧИХ дней (N=0 → ближайший рабочий день, включая сам день).
   * Обе границы — под горизонтом сид-календаря, иначе честный отказ.
   */
  async addWorkDays(fromStr: string, workDays: number): Promise<string> {
    this.assertCovered(fromStr);
    let current = fromStr;
    let left = workDays;
    // N=0: «в этот же день» — если день нерабочий, ближайший следующий рабочий
    if (left === 0) {
      while (!(await this.isWorkDay(current))) {
        current = addDays(current, 1);
        this.assertCovered(current);
      }
      return current;
    }
    while (left > 0) {
      current = addDays(current, 1);
      this.assertCovered(current);
      if (await this.isWorkDay(current)) left -= 1;
    }
    return current;
  }

  /**
   * Рабочих дней ОТ сегодня ДО даты (не включая сегодня; отрицательное —
   * просрочено на столько рабочих дней). null — дата за горизонтом календаря:
   * лучше честное «не считается», чем недосчёт.
   */
  async workDaysLeft(todayStr: string, dueStr: string): Promise<number | null> {
    if (!this.covered(todayStr) || !this.covered(dueStr)) return null;
    if (todayStr === dueStr) return 0;
    const forward = todayStr < dueStr;
    let count = 0;
    let cur = forward ? todayStr : dueStr;
    const end = forward ? dueStr : todayStr;
    while (cur < end) {
      cur = addDays(cur, 1);
      if (await this.isWorkDay(cur)) count += 1;
    }
    return forward ? count : -count;
  }

  /** Календарные дни — производственный календарь не нужен */
  addCalendarDays(fromStr: string, days: number): string {
    return addDays(fromStr, days);
  }

  /** Месяцы (ст. 56: уведомление за месяц). 31 января + 1 месяц = 28/29 февраля. */
  addMonths(fromStr: string, months: number): string {
    const d = toDate(fromStr);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return toStr(d);
  }

  /** Сегодня в APP_TIMEZONE (кадровые даты — календарные, стенные) */
  today(): string {
    const tz = process.env.APP_TIMEZONE || 'Asia/Almaty';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  }
}
