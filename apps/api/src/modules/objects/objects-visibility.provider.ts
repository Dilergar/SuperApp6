import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { VisibilityTypeRegistry } from '../../core/visibility/visibility.registry';
import { ObjectsService } from './objects.service';

const STAFFING_RATE_FIELDS = new Set(['plannedRate', 'actualRate']);
const SHIFT_FIELDS = new Set(['shiftNote', 'outcome', 'lateMin', 'actualStartAt', 'actualEndAt', 'attendanceNote']);
const ATTENDANCE_FIELDS = new Set(['outcome', 'lateMin', 'actualStartAt', 'actualEndAt', 'attendanceNote']);

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Типы записей «Объектов» в движке видимости: `objects.staffing` (деньги штатки) и
 * `objects.shift` (заметка к смене и факт выхода). Раскрытие ОДНОЙ записи, если политика
 * организации дала маску с раскрытием. Право на ЗАПИСЬ — право видеть объект
 * (`ObjectsService.getOrThrow`: `caps.view` по объекту и его предкам); чужое — `null` (404).
 * Оклад по договору и сведения КЭДО раскрываются в карточке сотрудника (`hr.employment`), не здесь.
 */
@Injectable()
export class ObjectsVisibilityProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly objects: ObjectsService,
    private readonly types: VisibilityTypeRegistry,
  ) {}

  onModuleInit(): void {
    this.types.register('objects.staffing', {
      loadForReveal: async (viewerId, workspaceId, recordId, fields) => {
        if (!workspaceId || !fields.length || fields.some((f) => !STAFFING_RATE_FIELDS.has(f))) return null;
        const now = new Date();
        const current = { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] };
        const assignment = await this.db.staffAssignment.findFirst({ where: { id: recordId, workspaceId }, select: { id: true, userId: true, branchId: true } });
        const unit = assignment ? null : await this.db.staffingPosition.findFirst({ where: { id: recordId, workspaceId }, select: { id: true, branchId: true } });
        const branchId = assignment?.branchId ?? unit?.branchId;
        if (!branchId || !(await this.canView(viewerId, workspaceId, branchId))) return null;
        const rate = await this.db.staffRate.findFirst({
          where: { workspaceId, ...(assignment ? { assignmentId: assignment.id } : { staffingPositionId: unit!.id }), ...current },
          orderBy: { effectiveFrom: 'desc' },
          select: { rateType: true, amount: true, currency: true, effectiveFrom: true, effectiveTo: true },
        });
        const value = rate
          ? { rateType: rate.rateType, amount: String(rate.amount), currency: rate.currency, effectiveFrom: rate.effectiveFrom.toISOString().slice(0, 10), effectiveTo: rate.effectiveTo ? rate.effectiveTo.toISOString().slice(0, 10) : null }
          : null;
        const values: Record<string, unknown> = {};
        for (const f of fields) values[f] = (f === 'actualRate') === !!assignment ? value : null;
        return { ref: { recordId, subjectId: assignment?.userId ?? null, workspaceId, branchId }, values };
      },
    });

    this.types.register('objects.shift', {
      loadForReveal: async (viewerId, workspaceId, recordId, fields) => {
        if (!workspaceId || !fields.length || fields.some((f) => !SHIFT_FIELDS.has(f))) return null;
        const shift = await this.db.shift.findFirst({
          where: { id: recordId, workspaceId },
          select: { id: true, branchId: true, userId: true, note: true, attendance: { take: 1 } },
        });
        // Внеплановый факт живёт без смены — его id и есть запись
        const unplanned = shift ? null : await this.db.shiftAttendance.findFirst({ where: { id: recordId, workspaceId } });
        if (unplanned && fields.some((f) => !ATTENDANCE_FIELDS.has(f))) return null;
        const branchId = shift?.branchId ?? unplanned?.branchId;
        if (!branchId || !(await this.canView(viewerId, workspaceId, branchId))) return null;
        const att = shift?.attendance[0] ?? unplanned ?? null;
        const all: Record<string, unknown> = {
          shiftNote: shift?.note ?? null,
          outcome: att?.outcome ?? null,
          lateMin: att?.lateMin ?? null,
          actualStartAt: iso(att?.actualStartAt ?? null),
          actualEndAt: iso(att?.actualEndAt ?? null),
          attendanceNote: att?.note ?? null,
        };
        return {
          ref: { recordId, subjectId: shift?.userId ?? unplanned?.userId ?? null, workspaceId, branchId },
          values: Object.fromEntries(fields.map((f) => [f, all[f] ?? null])),
        };
      },
    });
  }

  /** Право на запись — видеть объект (иначе движок отвечает тем же 404, что и на чужое). */
  private async canView(viewerId: string, workspaceId: string, branchId: string): Promise<boolean> {
    try {
      await this.objects.getOrThrow(viewerId, workspaceId, branchId);
      return true;
    } catch {
      return false;
    }
  }
}
