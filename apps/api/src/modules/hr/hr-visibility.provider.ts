import { Injectable, OnModuleInit } from '@nestjs/common';
import { visibilityFieldsOf } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { VisibilityTypeRegistry } from '../../core/visibility/visibility.registry';
import { HrService } from './hr.service';

/** Поля реестра `hr.employment` — то, что вообще можно раскрыть по одной записи */
const EMPLOYMENT_FIELDS = new Set(visibilityFieldsOf('hr.employment').map((e) => e.key));

/**
 * Тип записи `hr.employment` (трудовая карточка КЭДО) в движке видимости. Раскрытие ОДНОЙ
 * карточки (если политика организации дала раскрытие маски оклада/основания): право на
 * ЗАПИСЬ — тот же гейт, что у страницы человека (сам или Менеджер+ этой организации);
 * чужая или несуществующая карточка — `null` (движок отвечает одинаковым 404).
 */
@Injectable()
export class HrVisibilityProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly hr: HrService,
    private readonly types: VisibilityTypeRegistry,
  ) {}

  onModuleInit(): void {
    this.types.register('hr.employment', {
      loadForReveal: async (viewerId, workspaceId, recordId, fields) => {
        if (!workspaceId || !fields.length || fields.some((f) => !EMPLOYMENT_FIELDS.has(f))) return null;
        const row = await this.db.employment.findFirst({ where: { id: recordId, workspaceId } });
        if (!row) return null;
        if (row.userId !== viewerId && !this.hr.isManager(await this.hr.roleOf(viewerId, workspaceId))) return null;
        const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
        const all: Record<string, unknown> = {
          hiredAt: date(row.hiredAt),
          firedAt: date(row.firedAt),
          contractNumber: row.contractNumber,
          contractDate: date(row.contractDate),
          contractType: row.contractType,
          contractEndAt: date(row.contractEndAt),
          probationUntil: date(row.probationUntil),
          workRate: row.workRate,
          workSchedule: row.workSchedule,
          personnelNumber: row.personnelNumber,
          dismissalGround: row.dismissalGround,
          salaryAmount: row.salaryAmount === null ? null : String(row.salaryAmount),
        };
        return {
          ref: { recordId: row.id, subjectId: row.userId, workspaceId, stage: row.status, branchId: row.legalBranchId },
          values: Object.fromEntries(fields.map((f) => [f, all[f] ?? null])),
        };
      },
    });
  }
}
