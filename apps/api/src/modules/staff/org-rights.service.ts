import { ForbiddenException, Injectable } from '@nestjs/common';
import { ORG_ERROR_CODES, STAFF_FULL_SCOPE_ROLES, WORKSPACE_ROLE_RANK, type OrgScopeDto, type WorkspaceRole } from '@superapp/shared';
import { AccessService } from '../../core/access/access.service';
import { RolesService } from '../../core/roles/roles.service';
import { DatabaseService } from '../../shared/database/database.service';

const WS_CONTEXT = 'workspace';

/**
 * Областные права оргструктуры (модель Bitrix24: руководитель правит СВОЮ ветку, видит
 * всю схему). Области ДОБАВЛЯЮТ права, а не отнимают: роль ∈ STAFF_FULL_SCOPE_ROLES
 * по-прежнему полновластна (сужение до owner/admin — одной константой вместе с ролью
 * «Кадры»).
 *
 * Источник области — проекция core/access, а не обход дерева: голова отдела записана
 * `department#head` на отдел И ВСЕХ ЕГО ПОТОМКОВ (closure вниз), голова объекта —
 * `branch#head`. Читается `grantSetFor` (живые tuples, без кэша по замыслу) —
 * `granted.get('head')`, не `principalIdsOfType` (тот игнорирует отношение).
 *
 * Голова объекта правит НАЗНАЧЕНИЯ в своём объекте; отделы — нет (типовая схема
 * общая для сети). Явный делегат (`department#manager`) правит ветку наравне с головой.
 */
@Injectable()
export class OrgRightsService {
  constructor(
    private readonly roles: RolesService,
    private readonly access: AccessService,
    private readonly db: DatabaseService,
  ) {}

  async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  async scopeOf(userId: string, workspaceId: string, role?: WorkspaceRole | null): Promise<OrgScopeDto> {
    const r = role === undefined ? await this.roleOf(userId, workspaceId) : role;
    if (!r || r === 'contractor') return { kind: 'none', departmentIds: [], branchIds: [], role: r ?? null };
    if (STAFF_FULL_SCOPE_ROLES.includes(r)) return { kind: 'all', departmentIds: [], branchIds: [], role: r };

    // Рёбра прав не несут workspaceId: человек — голова отделов в НЕСКОЛЬКИХ организациях
    // (в т.ч. архивных), а область — про ЭТУ. Пересекаем с её справочниками.
    const [deps, brs, ownDeps, ownBrs] = await Promise.all([
      this.access.grantSetFor(userId, 'department'),
      this.access.grantSetFor(userId, 'branch'),
      this.db.staffDepartment.findMany({ where: { workspaceId }, select: { id: true } }),
      this.db.staffBranch.findMany({ where: { workspaceId }, select: { id: true } }),
    ]);
    const ownDepIds = new Set(ownDeps.map((d) => d.id));
    const ownBrIds = new Set(ownBrs.map((b) => b.id));
    const departmentIds = [...new Set([...(deps.granted.get('head') ?? []), ...(deps.granted.get('manager') ?? [])])].filter((id) => ownDepIds.has(id));
    const branchIds = [...new Set(brs.granted.get('head') ?? [])].filter((id) => ownBrIds.has(id));
    if (!departmentIds.length && !branchIds.length) return { kind: 'none', departmentIds: [], branchIds: [], role: r };
    return { kind: 'scoped', departmentIds, branchIds, role: r };
  }

  /** Отдел в области? (`all` — всегда; `scoped` — по списку с потомками из проекции) */
  static coversDepartment(scope: OrgScopeDto, departmentId: string | null): boolean {
    if (scope.kind === 'all') return true;
    if (scope.kind === 'none') return false;
    return !!departmentId && scope.departmentIds.includes(departmentId);
  }

  static coversBranch(scope: OrgScopeDto, branchId: string | null): boolean {
    if (scope.kind === 'all') return true;
    if (scope.kind === 'none') return false;
    return !!branchId && scope.branchIds.includes(branchId);
  }

  /**
   * Назначение в области: отдел должности — в моей ветке ИЛИ объект — мой.
   * Должность без отдела правится только через объект.
   */
  static coversAssignment(scope: OrgScopeDto, departmentId: string | null, branchId: string | null): boolean {
    if (scope.kind === 'all') return true;
    if (scope.kind === 'none') return false;
    return OrgRightsService.coversDepartment(scope, departmentId) || OrgRightsService.coversBranch(scope, branchId);
  }

  static forbid(what = 'Это вне вашей области: править можно только свою ветку или объект'): ForbiddenException {
    return new ForbiddenException({ message: what, details: { code: ORG_ERROR_CODES.scopeForbidden } });
  }
}
