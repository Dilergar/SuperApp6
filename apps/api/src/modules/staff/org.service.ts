import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ORG_ERROR_CODES,
  ORG_LIMITS,
  TEAM_WORKSPACE_ROLES,
  WORKSPACE_ROLE_RANK,
  type CreateStaffDeputyInput,
  type OrgChartDto,
  type OrgChartEdgeDto,
  type OrgChartPositionDto,
  type OrgDeputyDto,
  type OrgLineDto,
  type OrgManagerDto,
  type OrgPersonLite,
  type OrgScopeDto,
  type OrgSetupInput,
  type OrgSetupResultDto,
  type OrgUnassignedDto,
  type UpdateStaffDeputyInput,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { NotificationsService } from '../../core/notifications/notifications.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { fullName } from '../../shared/utils/user-name';
import { OrgGraphService } from './org-graph.service';
import { OrgRightsService } from './org-rights.service';
import { StaffService } from './staff.service';
import {
  departmentDepth,
  holdersForPosition,
  isDeputyActiveOn,
  isDeputyDated,
  managerChainOf,
  managerOf,
  orgToday,
  pickAssignment,
  rootPositionIds,
  subordinateIdsOf,
  superiorPositionOf,
  type ManagerResolution,
  type OrgDeputyRow,
  type OrgGraph,
  branchHeadHolders,
} from './org-resolve';

const WS_CONTEXT = 'workspace';

/**
 * Ключи периода замещения — ЛИТЕРАЛАМИ, а не сборкой `staff.${variant}.range`:
 * такая сборка дала бы стражу каталога префикс «staff.» целиком, и он перестал бы
 * замечать мёртвые ключи всего неймспейса. Хроника даёт суффикс к фразе
 * (« (с … по …)»), уведомление — отдельную строку («Период: …»).
 */
const DEPUTY_PERIOD_KEYS = {
  deputyPeriod: {
    range: 'staff.deputyPeriod.range',
    from: 'staff.deputyPeriod.from',
    until: 'staff.deputyPeriod.until',
    // Без дат суффикса в хронике нет вовсе: ключа нет → в тексте пустая строка.
    none: null,
  },
  deputyNotice: {
    range: 'staff.deputyNotice.range',
    from: 'staff.deputyNotice.from',
    until: 'staff.deputyNotice.until',
    // Уведомление обязано объяснить, что заместитель запасной.
    none: 'staff.deputyNotice.standing',
  },
} as const;

/**
 * Читающее API оргструктуры (граф, «место в структуре», «вне структуры», область) +
 * заместители + мастер первичной сборки. Вертикаль считает org-resolve над снимком
 * OrgGraphService; права — OrgRightsService; мутации справочников — StaffService.
 *
 * Единственный санкционированный вход «кто мой руководитель / моя команда» для чужих
 * сервисов — `managerOf` / `subordinateIdsOf` (регистрируются в core/audiences).
 */
@Injectable()
export class OrgService {
  constructor(
    private readonly db: DatabaseService,
    private readonly graph: OrgGraphService,
    private readonly rights: OrgRightsService,
    private readonly staff: StaffService,
    private readonly chatter: ChatterService,
    private readonly notifications: NotificationsService,
  ) {}

  // ============================================================
  // Санкционированные резолверы (для core/audiences и чужих сервисов)
  // ============================================================

  /** Руководитель человека по факту назначений (owner_fallback на вершине). Прав не проверяет. */
  async managerOf(workspaceId: string, userId: string, opts: { branchId?: string | null; assignmentId?: string | null } = {}): Promise<ManagerResolution> {
    const g = await this.graph.load(workspaceId);
    return managerOf(g, userId, opts);
  }

  /** Подчинённые человека — точная инверсия managerOf. Прав не проверяет. */
  async subordinateIdsOf(workspaceId: string, userId: string): Promise<string[]> {
    const g = await this.graph.load(workspaceId);
    return subordinateIdsOf(g, userId);
  }

  /**
   * Держатели руководящей должности объекта; своей нет — поднимаемся к ближайшему
   * предку в дереве объектов (лестница замещений внутри).
   */
  async branchHeadUserIds(workspaceId: string, branchId: string): Promise<string[]> {
    const g = await this.graph.load(workspaceId);
    return branchHeadHolders(g, branchId, orgToday()).userIds;
  }

  // ============================================================
  // Чтение
  // ============================================================

  async chart(viewerId: string, workspaceId: string, q: { branchId?: string; focus?: string }): Promise<OrgChartDto> {
    const role = await this.assertTeamMember(viewerId, workspaceId);
    const [g, scope, requisites] = await Promise.all([
      this.graph.load(workspaceId),
      this.rights.scopeOf(viewerId, workspaceId, role),
      // Директор ГОЛОВНОГО юрлица — вершина схемы организации.
      this.db.legalEntity.findFirst({
        where: { workspaceId, isHead: true },
        select: { directorUserId: true },
      }),
    ]);
    if (g.positions.length > ORG_LIMITS.maxChartPositions) {
      throw conflict('org.chartTooBig', { max: ORG_LIMITS.maxChartPositions }, { code: ORG_ERROR_CODES.chartTooBig });
    }
    const branchId = q.branchId ?? null;
    if (branchId && !g.branchById.has(branchId)) throw notFound('staff.branchNotFound');
    const at = orgToday();

    const headsDep = new Map<string, string[]>();
    for (const d of g.departments) {
      if (!d.headPositionId) continue;
      headsDep.set(d.headPositionId, [...(headsDep.get(d.headPositionId) ?? []), d.id]);
    }
    const headsBr = new Map<string, string[]>();
    for (const b of g.branches) {
      if (!b.headPositionId) continue;
      headsBr.set(b.headPositionId, [...(headsBr.get(b.headPositionId) ?? []), b.id]);
    }

    const userIds = new Set<string>();
    const positions: OrgChartPositionDto[] = g.positions.map((p) => {
      const rows = g.assignments.filter(
        (a) => a.positionId === p.id && (!branchId || a.branchId === branchId) && g.memberRole.has(a.userId),
      );
      rows.forEach((a) => userIds.add(a.userId));
      return {
        id: p.id,
        name: p.name,
        glyph: p.glyph,
        departmentId: p.departmentId,
        reportsToPositionId: p.reportsToPositionId,
        superiorPositionId: superiorPositionOf(g, p.id, branchId),
        holders: rows.map((a) => ({
          userId: a.userId,
          assignmentId: a.id,
          branchId: a.branchId,
          isPrimary: a.isPrimary,
          status: a.status as 'training' | 'certified',
        })),
        vacant: rows.length === 0,
        headsDepartmentIds: headsDep.get(p.id) ?? [],
        headsBranchIds: headsBr.get(p.id) ?? [],
        sortOrder: p.sortOrder,
      };
    });

    const edges: OrgChartEdgeDto[] = [];
    for (const p of positions) {
      if (p.superiorPositionId) edges.push({ from: p.superiorPositionId, to: p.id, kind: 'reports' });
    }
    const deputyRows = g.deputies.filter((d) => !branchId || d.branchId === null || d.branchId === branchId);
    for (const d of deputyRows) {
      if (d.deputyPositionId) {
        edges.push({ from: d.deputyPositionId, to: d.positionId, kind: 'deputy', startsOn: d.startsOn, endsOn: d.endsOn });
      }
      if (d.deputyUserId) userIds.add(d.deputyUserId);
    }
    if (g.ownerId) userIds.add(g.ownerId);
    if (requisites?.directorUserId) userIds.add(requisites.directorUserId);

    const people = await this.peopleLite([...userIds]);
    const unassigned = g.members.filter((m) => !g.assignmentsByUser.has(m.userId)).length;
    const vacancies = positions.filter((p) => p.vacant).length;
    const suggestedTopUserId =
      requisites?.directorUserId && g.memberRole.has(requisites.directorUserId) ? requisites.directorUserId : null;

    return {
      workspaceId,
      branchId,
      positions,
      departments: g.departments.map((d) => ({
        id: d.id,
        name: d.name,
        parentId: d.parentId,
        headPositionId: d.headPositionId,
        depth: departmentDepth(g, d.id),
        sortOrder: d.sortOrder,
      })),
      branches: g.branches.map((b) => ({ id: b.id, name: b.name, isDefault: b.isDefault, headPositionId: b.headPositionId })),
      edges,
      roots: rootPositionIds(g, branchId),
      people,
      ownerUserId: g.ownerId,
      ownerInChart: g.assignmentsByUser.has(g.ownerId),
      myPositionIds: [...new Set((g.assignmentsByUser.get(viewerId) ?? []).map((a) => a.positionId))],
      scope,
      assembled: g.departments.some((d) => !!d.headPositionId) || g.branches.some((b) => !!b.headPositionId) || g.positions.some((p) => !!p.reportsToPositionId),
      suggestedTopUserId,
      deputies: deputyRows.map((d) => this.serializeDeputy(g, d, at)),
      counts: {
        positions: g.positions.length,
        departments: g.departments.length,
        branches: g.branches.length,
        people: g.members.length,
        unassigned,
        vacancies,
      },
    };
  }

  async unassigned(viewerId: string, workspaceId: string): Promise<OrgUnassignedDto> {
    await this.assertTeamMember(viewerId, workspaceId);
    const g = await this.graph.load(workspaceId);
    const people = g.members
      .filter((m) => !g.assignmentsByUser.has(m.userId))
      .map((m) => ({ userId: m.userId, role: m.role as WorkspaceRole }))
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b.role] ?? 0) - (WORKSPACE_ROLE_RANK[a.role] ?? 0));
    const vacancies = g.positions
      .filter((p) => !(g.holdersByPosBranch.get(p.id)?.size ?? 0))
      .map((p) => ({ positionId: p.id, name: p.name }));
    const roots = rootPositionIds(g, null).map((id) => ({ positionId: id, name: g.positionById.get(id)?.name ?? '' }));
    return { people, vacancies, roots, persons: await this.peopleLite(people.map((p) => p.userId)) };
  }

  async myScope(viewerId: string, workspaceId: string): Promise<OrgScopeDto> {
    const role = await this.assertTeamMember(viewerId, workspaceId);
    return this.rights.scopeOf(viewerId, workspaceId, role);
  }

  async line(
    viewerId: string,
    workspaceId: string,
    userId: string,
    q: { branchId?: string; assignmentId?: string },
  ): Promise<OrgLineDto> {
    await this.assertTeamMember(viewerId, workspaceId);
    const g = await this.graph.load(workspaceId);
    if (!g.memberRole.has(userId)) throw notFound('staff.notInWorkspace');
    const at = orgToday();
    const assignments = g.assignmentsByUser.get(userId) ?? [];
    const picked = pickAssignment(g, userId, q);
    const manager = managerOf(g, userId, { ...q, at });
    const chain = managerChainOf(g, userId, { ...q, at });
    const team = subordinateIdsOf(g, userId, at);
    const others = assignments
      .filter((a) => a.id !== picked?.id)
      .map((a) => ({ assignmentId: a.id, manager: this.serializeManager(g, managerOf(g, userId, { assignmentId: a.id, at })) }));

    const ids = new Set<string>([userId, ...manager.userIds]);
    chain.forEach((s) => s.userIds.forEach((u) => ids.add(u)));
    others.forEach((o) => o.manager.userIds.forEach((u) => ids.add(u)));
    team.slice(0, 60).forEach((u) => ids.add(u));

    return {
      userId,
      assignments: assignments.map((a) => {
        const p = g.positionById.get(a.positionId);
        const d = p?.departmentId ? g.departmentById.get(p.departmentId) : null;
        const b = g.branchById.get(a.branchId);
        return {
          assignmentId: a.id,
          positionId: a.positionId,
          positionName: p?.name ?? '',
          departmentId: p?.departmentId ?? null,
          departmentName: d?.name ?? null,
          branchId: a.branchId,
          branchName: b?.name ?? '',
          isPrimary: a.isPrimary,
          status: a.status as 'training' | 'certified',
        };
      }),
      resolvedAssignmentId: picked?.id ?? null,
      manager: this.serializeManager(g, manager),
      chain: chain.map((s) => ({
        positionId: s.positionId,
        positionName: g.positionById.get(s.positionId)?.name ?? '',
        userIds: s.userIds,
        viaDeputy: s.viaDeputy,
      })),
      team: { userIds: team, count: team.length },
      others,
      people: await this.peopleLite([...ids]),
    };
  }

  // ============================================================
  // Заместители
  // ============================================================

  async listDeputies(viewerId: string, workspaceId: string, q: { positionId?: string; activeOnly?: boolean }): Promise<OrgDeputyDto[]> {
    await this.assertTeamMember(viewerId, workspaceId);
    const g = await this.graph.load(workspaceId);
    const at = orgToday();
    return g.deputies
      .filter((d) => !q.positionId || d.positionId === q.positionId)
      .filter((d) => !q.activeOnly || !isDeputyDated(d) || isDeputyActiveOn(d, at))
      .map((d) => this.serializeDeputy(g, d, at));
  }

  async createDeputy(actorId: string, workspaceId: string, dto: CreateStaffDeputyInput): Promise<OrgDeputyDto> {
    const g = await this.graph.loadFresh(workspaceId);
    await this.assertCanManageDeputies(actorId, workspaceId, g, dto.positionId, dto.branchId ?? null);
    const position = g.positionById.get(dto.positionId);
    if (!position) throw notFound('staff.positionNotFound');
    if (dto.branchId && !g.branchById.has(dto.branchId)) throw notFound('staff.branchNotFound');
    if (dto.deputyPositionId && !g.positionById.has(dto.deputyPositionId)) {
      throw notFound('org.deputyPositionNotFound');
    }
    if (dto.deputyUserId) {
      const role = g.memberRole.get(dto.deputyUserId);
      if (!role) {
        throw badRequest('org.deputyNotMember', undefined, { code: ORG_ERROR_CODES.deputyTarget });
      }
    }
    const count = g.deputiesByPosition.get(dto.positionId)?.length ?? 0;
    if (count >= ORG_LIMITS.maxDeputiesPerPosition) {
      throw badRequest('org.deputyLimit', { max: ORG_LIMITS.maxDeputiesPerPosition });
    }
    // Подписи для вечной записи — до транзакции (имена читаются, не пишутся).
    const actorNamePre = await this.nameOf(actorId);
    const deputyTargetPre = this.deputyTargetPayload(
      dto.deputyPositionId ? (g.positionById.get(dto.deputyPositionId)?.name ?? '') : null,
      dto.deputyPositionId ? null : await this.nameOf(dto.deputyUserId!),
    );
    let row: { id: string };
    try {
      row = await this.db.$transaction(async (tx) => {
        const created = await tx.staffDeputy.create({
          data: {
            workspaceId,
            positionId: dto.positionId,
            branchId: dto.branchId ?? null,
            deputyPositionId: dto.deputyPositionId ?? null,
            deputyUserId: dto.deputyUserId ?? null,
            startsOn: dto.startsOn ? new Date(dto.startsOn) : null,
            endsOn: dto.endsOn ? new Date(dto.endsOn) : null,
            note: dto.note ?? null,
            createdById: actorId,
          },
          select: { id: true },
        });
        // Хроника — в той же транзакции, что и сама запись (правило канона).
        await this.chatter.log(tx, {
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName: actorNamePre,
          typeKey: 'staff.deputy_opened',
          payload: {
            deputyId: created.id,
            positionName: position.name,
            ...deputyTargetPre,
            ...this.periodPayload('deputyPeriod', dto.startsOn ?? null, dto.endsOn ?? null),
          },
        });
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw conflict('org.deputyDuplicate');
      }
      throw e;
    }
    await this.graph.invalidate(workspaceId);
    const fresh = await this.graph.load(workspaceId);
    const created = fresh.deputies.find((d) => d.id === row.id)!;
    const dtoOut = this.serializeDeputy(fresh, created, orgToday());

    // Уведомить заместителя: человека — прямо; должность — её держателей (в объекте, если задан).
    const recipients = dtoOut.deputyUserId
      ? [dtoOut.deputyUserId]
      : [
          ...new Set(
            fresh.assignments
              .filter((a) => a.positionId === dtoOut.deputyPositionId && (!dtoOut.branchId || a.branchId === dtoOut.branchId))
              .map((a) => a.userId),
          ),
        ];
    if (recipients.length) {
      const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
      await this.notifications.send(null, {
        type: 'staff.deputy.assigned',
        to: recipients.map((id) => ({ userId: id })),
        payload: {
          workspaceId,
          workspaceName: ws?.name ?? '',
          positionName: position.name,
          ...this.periodPayload('deputyNotice', dto.startsOn ?? null, dto.endsOn ?? null),
        },
        workspaceId,
        reason: 'assigned',
        actionUrl: `/workspaces/${workspaceId}/members/org`,
      });
    }
    return dtoOut;
  }

  async updateDeputy(actorId: string, workspaceId: string, deputyId: string, dto: UpdateStaffDeputyInput): Promise<OrgDeputyDto> {
    const g = await this.graph.loadFresh(workspaceId);
    const row = g.deputies.find((d) => d.id === deputyId);
    if (!row) throw notFound('org.deputyNotFound');
    await this.assertCanManageDeputies(actorId, workspaceId, g, row.positionId, row.branchId);
    const startsOn = dto.startsOn !== undefined ? dto.startsOn : row.startsOn;
    const endsOn = dto.endsOn !== undefined ? dto.endsOn : row.endsOn;
    if (startsOn && endsOn && endsOn < startsOn) throw badRequest('org.periodEnd');
    try {
      await this.db.staffDeputy.update({
        where: { id: deputyId },
        data: {
          ...(dto.startsOn !== undefined ? { startsOn: dto.startsOn ? new Date(dto.startsOn) : null } : {}),
          ...(dto.endsOn !== undefined ? { endsOn: dto.endsOn ? new Date(dto.endsOn) : null } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw conflict('org.deputyDuplicate');
      }
      throw e;
    }
    await this.graph.invalidate(workspaceId);
    const fresh = await this.graph.load(workspaceId);
    return this.serializeDeputy(fresh, fresh.deputies.find((d) => d.id === deputyId)!, orgToday());
  }

  async deleteDeputy(actorId: string, workspaceId: string, deputyId: string): Promise<void> {
    const g = await this.graph.loadFresh(workspaceId);
    const row = g.deputies.find((d) => d.id === deputyId);
    if (!row) throw notFound('org.deputyNotFound');
    await this.assertCanManageDeputies(actorId, workspaceId, g, row.positionId, row.branchId);
    const dto = this.serializeDeputy(g, row, orgToday());
    const deputyTarget = this.deputyTargetPayload(
      dto.deputyPositionName,
      dto.deputyPositionName ? null : await this.nameOf(dto.deputyUserId!),
    );
    const actorName = await this.nameOf(actorId);
    await this.db.$transaction(async (tx) => {
      await tx.staffDeputy.delete({ where: { id: deputyId } });
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId,
        actorName,
        typeKey: 'staff.deputy_closed',
        payload: { deputyId, positionName: dto.positionName, ...deputyTarget },
      });
    });
    await this.graph.invalidate(workspaceId);
  }

  /**
   * Кто ставит заместителя: сам держатель должности · его руководитель · полновластные
   * роли · голова ветки/объекта, куда входит должность.
   */
  private async assertCanManageDeputies(actorId: string, workspaceId: string, g: OrgGraph, positionId: string, branchId: string | null): Promise<void> {
    const role = await this.assertTeamMember(actorId, workspaceId);
    const scope = await this.rights.scopeOf(actorId, workspaceId, role);
    if (scope.kind === 'all') return;
    const position = g.positionById.get(positionId);
    if (!position) throw notFound('staff.positionNotFound');
    if (OrgRightsService.coversAssignment(scope, position.departmentId, branchId)) return;
    const holders = g.assignments.filter((a) => a.positionId === positionId && (!branchId || a.branchId === branchId));
    if (holders.some((a) => a.userId === actorId)) return;
    for (const h of holders) {
      if (managerOf(g, h.userId, { assignmentId: h.id }).userIds.includes(actorId)) return;
    }
    throw forbidden('org.deputyManageForbidden', undefined, { code: ORG_ERROR_CODES.scopeForbidden });
  }

  // ============================================================
  // Мастер «Соберём структуру»
  // ============================================================

  async setup(actorId: string, workspaceId: string, dto: OrgSetupInput): Promise<OrgSetupResultDto> {
    await this.staff.assertOrgWideStaffManage(actorId, workspaceId);
    let topPositionId: string | null = null;
    if (dto.top) {
      if (dto.top.newPositionName) {
        const created = await this.staff.createPosition(actorId, workspaceId, { name: dto.top.newPositionName });
        topPositionId = created.id;
      } else {
        topPositionId = dto.top.positionId ?? null;
      }
      if (topPositionId && dto.top.userId) {
        const g = await this.graph.loadFresh(workspaceId);
        const has = (g.assignmentsByUser.get(dto.top.userId) ?? []).some((a) => a.positionId === topPositionId);
        if (!has) {
          await this.staff.assignPosition(actorId, workspaceId, dto.top.userId, { positionId: topPositionId, status: 'certified', isPrimary: true });
        }
      }
      // Вершина = голова ОСНОВНОГО объекта: только так должности без отдела (и объекты
      // без своей головы в типовой схеме) подчиняются ей, а не висят корнями.
      if (topPositionId) {
        const def = await this.staff.ensureDefaultBranch(workspaceId);
        const branch = await this.db.staffBranch.findUnique({ where: { id: def.id }, select: { headPositionId: true } });
        if (branch && branch.headPositionId !== topPositionId) {
          await this.staff.updateBranch(actorId, workspaceId, def.id, { headPositionId: topPositionId });
        }
      }
    }
    let departmentsUpdated = 0;
    for (const h of dto.departmentHeads ?? []) {
      await this.staff.updateDepartment(actorId, workspaceId, h.departmentId, { headPositionId: h.positionId });
      departmentsUpdated += 1;
    }
    let branchesUpdated = 0;
    for (const h of dto.branchHeads ?? []) {
      await this.staff.updateBranch(actorId, workspaceId, h.branchId, { headPositionId: h.positionId });
      branchesUpdated += 1;
    }
    return { topPositionId, departmentsUpdated, branchesUpdated };
  }

  // ============================================================
  // Helpers
  // ============================================================

  private serializeManager(g: OrgGraph, r: ManagerResolution): OrgManagerDto {
    return {
      positionId: r.positionId,
      positionName: r.positionId ? (g.positionById.get(r.positionId)?.name ?? null) : null,
      userIds: r.userIds,
      viaDeputy: r.viaDeputy,
      deputyUntil: r.deputyUntil,
      branchId: r.branchId,
      reason: r.reason,
    };
  }

  private serializeDeputy(g: OrgGraph, d: OrgDeputyRow, at: string): OrgDeputyDto {
    const dated = isDeputyDated(d);
    return {
      id: d.id,
      positionId: d.positionId,
      positionName: g.positionById.get(d.positionId)?.name ?? '',
      branchId: d.branchId,
      branchName: d.branchId ? (g.branchById.get(d.branchId)?.name ?? null) : null,
      deputyPositionId: d.deputyPositionId,
      deputyPositionName: d.deputyPositionId ? (g.positionById.get(d.deputyPositionId)?.name ?? null) : null,
      deputyUserId: d.deputyUserId,
      startsOn: d.startsOn,
      endsOn: d.endsOn,
      note: d.note,
      kind: dated ? 'temporary' : 'standing',
      activeToday: !dated || isDeputyActiveOn(d, at),
      createdById: d.createdById,
      createdAt: d.createdAt,
    };
  }

  /**
   * Период замещения в ВЕЧНОЙ записи — не слова, а ключ каталога рядом с датами:
   * хроника и уведомление собираются в языке ЧИТАТЕЛЯ (render-at-read), а не того,
   * кто нажал кнопку.
   */
  private periodPayload(
    variant: keyof typeof DEPUTY_PERIOD_KEYS,
    startsOn: string | null,
    endsOn: string | null,
  ): Record<string, string> {
    // Даты уезжают машинными (`YYYY-MM-DD`) с суффиксом `Iso`: словами и правилами
    // их оденет рендер в языке ЗРИТЕЛЯ — запись живёт годами, а зрителей у неё много.
    const keys = DEPUTY_PERIOD_KEYS[variant];
    if (startsOn && endsOn) return { periodLabelKey: keys.range, startsOnIso: startsOn, endsOnIso: endsOn };
    if (startsOn) return { periodLabelKey: keys.from, startsOnIso: startsOn };
    if (endsOn) return { periodLabelKey: keys.until, endsOnIso: endsOn };
    return keys.none ? { periodLabelKey: keys.none } : {};
  }

  /** Кто замещает: должность даёт КЛЮЧ каталога, человек — своё имя (это данные). */
  private deputyTargetPayload(positionName: string | null, personName: string | null): Record<string, string> {
    return positionName
      ? { deputyLabelKey: 'staff.deputyTarget.position', deputyPositionName: positionName }
      : { deputyLabel: personName ?? '' };
  }

  private async peopleLite(ids: string[]): Promise<Record<string, OrgPersonLite>> {
    const out: Record<string, OrgPersonLite> = {};
    if (!ids.length) return out;
    const rows = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    for (const u of rows) out[u.id] = u;
    return out;
  }

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return fullName(u);
  }

  private async assertTeamMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const rows = await this.db.userRole.findMany({
      where: { userId, context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
      select: { role: true },
    });
    if (!rows.length) throw forbidden('workspace.noAccess');
    return rows
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }
}
