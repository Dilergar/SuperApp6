import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { AccessService } from '../../core/access/access.service';
import { VisibilityRelationRegistry } from '../../core/visibility/visibility.registry';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';
import { OrgGraphService } from './org-graph.service';
import { subordinateIdsOf } from './org-resolve';

/**
 * «Сотрудники» в движке видимости (core/visibility): ФАКТЫ оргструктуры для относительных
 * адресатов правил («руководитель субъекта», «руководитель объекта субъекта», «видит деньги
 * объекта», «ведёт график объекта»). Подчинённые — точная инверсия `managerOf` (тот же граф,
 * что у core/audiences); объекты — гранты `branch#head|manager|payroll_viewer|scheduler` с
 * потомками по дереву (как
 * `ObjectsService.capsFor`). Прав не проверяет — отвечает о фактах. Тип записи `staff.member`
 * регистрирует владелец реквизитного блока — `WorkspacesModule`.
 */
@Injectable()
export class StaffVisibilityProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly graph: OrgGraphService,
    private readonly relations: VisibilityRelationRegistry,
  ) {}

  onModuleInit(): void {
    this.relations.register({
      subordinateIdsOf: async (workspaceId, viewerId) => {
        const g = await this.graph.load(workspaceId);
        return g.memberRole.has(viewerId) ? subordinateIdsOf(g, viewerId) : [];
      },
      headedBranchIdsOf: (workspaceId, viewerId) => this.branchesWith(workspaceId, viewerId, ['head', 'manager']),
      payrollBranchIdsOf: (workspaceId, viewerId) => this.branchesWith(workspaceId, viewerId, ['head', 'manager', 'payroll_viewer']),
      schedulerBranchIdsOf: (workspaceId, viewerId) => this.branchesWith(workspaceId, viewerId, ['head', 'manager', 'scheduler']),
      branchIdsOfUsers: async (workspaceId, userIds) => {
        const out = new Map<string, string[]>();
        if (!userIds.length) return out;
        const rows = await this.db.staffAssignment.findMany({
          where: { workspaceId, userId: { in: [...userIds] }, ...activeAssignmentWhere() },
          select: { userId: true, branchId: true },
        });
        for (const r of rows) {
          const list = out.get(r.userId) ?? [];
          if (!list.includes(r.branchId)) list.push(r.branchId);
          out.set(r.userId, list);
        }
        return out;
      },
    });
  }

  /**
   * Объекты этой организации (с потомками), где у человека один из грантов. `grantSetFor`
   * НЕ скоупит по организации (рёбра не несут workspaceId) — пересечение здесь.
   */
  private async branchesWith(workspaceId: string, userId: string, relations: readonly string[]): Promise<string[]> {
    const set = await this.access.grantSetFor(userId, 'branch');
    const roots = new Set<string>();
    for (const rel of relations) for (const id of set.granted.get(rel) ?? []) roots.add(id);
    if (!roots.size) return [];
    const ids = [...roots];
    const rows = await this.db.staffBranch.findMany({
      where: { workspaceId, archivedAt: null, OR: [{ id: { in: ids } }, { ancestorIds: { hasSome: ids } }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
