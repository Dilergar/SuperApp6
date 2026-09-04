/**
 * Типы фоновых работ сервиса «Объекты» — ОТДЕЛЬНЫМ файлом.
 *
 * Константы нужны и обработчику (`objects.jobs.ts`), и тем, кто ставит джоб из
 * своей транзакции (`ShiftsService`, `StaffingService`). Держать их в
 * `objects.jobs.ts` нельзя: тот импортирует сервисы, и обратный импорт замкнул бы
 * модульный цикл на РАНТАЙМ-значениях (не на типах, где TS это прощает).
 */
export const OBJECTS_QUEUE = 'objects';
export const SHIFTS_GENERATE_JOB = 'objects.shifts.generate';
export const ASSIGNMENT_ROLLOVER_JOB = 'staff.assignment.rollover';
