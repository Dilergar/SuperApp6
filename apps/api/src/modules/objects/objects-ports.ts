import type { PlannedPayrollRowDto } from '@superapp/shared';

// ============================================================
// ПОРТЫ сервиса «Объекты» — контракты, по которым в него ходят чужие сервисы.
//
// Объект спроектирован как ХАБ: будущие Финансы читают план затрат (ставки ×
// смены), пропускная система пишет факт выходов в те же таблицы, AI и терминал
// зовут те же методы. Порт — это ИНТЕРФЕЙС, а не новый код: реализация уже живёт
// в StaffingService / AttendanceService, здесь фиксируется форма контракта,
// чтобы потребитель не зависел от внутренностей модуля.
// ============================================================

/** План и факт затрат на персонал по объектам — читают Финансы и отчёты. */
export interface ObjectsPayrollPort {
  /**
   * План затрат за период: строки по штатным единицам, включая ВАКАНСИИ
   * (незанятая ставка — тоже деньги в плане). Суммы — тиыны строкой.
   */
  getPlannedPayroll(
    workspaceId: string,
    q: { branchId?: string; from: string; to: string },
  ): Promise<{ rows: PlannedPayrollRowDto[]; totals: { plannedCost: string; currency: string } }>;
}

/** Факт выходов — пишет пропускная система (Face ID, турникет). */
export interface AttendancePort {
  /**
   * Событие прохода. Матчится с ближайшей ОПУБЛИКОВАННОЙ сменой человека в
   * объекте, опоздание считается от планового начала с допуском объекта
   * (`scheduleSettings.lateToleranceMin`).
   *
   * Контракт `system*`: прав НЕ проверяет — право проверяет вызывающий
   * (HTTP-обёртка `recordGateEvent` требует `branch.attendance.mark`).
   */
  recordAttendanceSystem(args: {
    workspaceId: string;
    userId: string;
    branchId: string;
    at: Date;
    direction: 'in' | 'out';
    source?: 'access_control' | 'self';
    sourceRef?: string | null;
  }): Promise<unknown>;
}

/** Строковые токены — для ленивых рёбер через ModuleRef (см. shared/di-tokens.ts). */
export const OBJECTS_PORT_TOKENS = {
  payroll: 'ObjectsPayrollPort',
  attendance: 'AttendancePort',
} as const;
