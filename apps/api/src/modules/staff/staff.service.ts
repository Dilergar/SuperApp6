import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import {
  STAFF_LIMITS,
  WORKSPACE_ROLE_RANK,
  type WorkspaceRole,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';

const WS_CONTEXT = 'workspace';

/** Prisma include для сериализации назначения с именами справочников. */
const ASSIGNMENT_INCLUDE = {
  position: {
    select: {
      name: true,
      departmentId: true,
      department: { select: { name: true } },
    },
  },
  branch: { select: { name: true } },
} satisfies Prisma.StaffAssignmentInclude;

type AssignmentRow = Prisma.StaffAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

/**
 * StaffService — сервис «Сотрудники» (B2B): справочники Должность/Отдел/Филиал +
 * назначения должностей.
 *
 * Инварианты:
 *   - Роль прав одна на организацию (UserRole) — справочники прав НЕ несут.
 *   - Членство в отделе — ПРОИЗВОДНОЕ от должности (Position.departmentId), модель
 *     штатного расписания 1С. Прямого назначения «человек → отдел» нет.
 *   - Назначение = человек × должность × (опц.) филиал; статус training|certified
 *     (Додзё будущего переключает; сейчас manager+ вручную).
 *   - «Подрядчик» (contractor) изолирован: staff-эндпоинты для него закрыты, должности
 *     ему не назначаются.
 *   - Каждая мутация проецирует рёбра position#holder / branch#member / department#member
 *     в core/access (будущий таргетинг Ленты/отпусков и card.full_viewer).
 */
@Injectable()
export class StaffService {
  constructor(
    private db: DatabaseService,
    private roles: RolesService,
    private events: EventBusService,
    private accessProjection: AccessProjectionService,
  ) {}

  // ============================================================
  // Справочники (одним ответом — для вкладок и форм)
  // ============================================================

  async getDirectory(userId: string, workspaceId: string) {
    await this.assertTeamMember(userId, workspaceId);

    const [departments, positions, branches, assignments] = await Promise.all([
      this.db.staffDepartment.findMany({
        where: { workspaceId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffPosition.findMany({
        where: { workspaceId },
        include: { department: { select: { name: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffBranch.findMany({
        where: { workspaceId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffAssignment.findMany({
        where: { workspaceId },
        select: {
          userId: true,
          positionId: true,
          branchId: true,
          position: { select: { departmentId: true } },
        },
      }),
    ]);

    // Счётчики (production: данных мало, считаем в JS одним проходом).
    const holdersByPosition = new Map<string, Set<string>>();
    const membersByBranch = new Map<string, Set<string>>();
    const membersByDepartment = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!holdersByPosition.has(a.positionId)) holdersByPosition.set(a.positionId, new Set());
      holdersByPosition.get(a.positionId)!.add(a.userId);
      if (a.branchId) {
        if (!membersByBranch.has(a.branchId)) membersByBranch.set(a.branchId, new Set());
        membersByBranch.get(a.branchId)!.add(a.userId);
      }
      const depId = a.position.departmentId;
      if (depId) {
        if (!membersByDepartment.has(depId)) membersByDepartment.set(depId, new Set());
        membersByDepartment.get(depId)!.add(a.userId);
      }
    }
    const positionsByDepartment = new Map<string, number>();
    for (const p of positions) {
      if (p.departmentId) {
        positionsByDepartment.set(p.departmentId, (positionsByDepartment.get(p.departmentId) ?? 0) + 1);
      }
    }

    return {
      departments: departments.map((d) => ({
        id: d.id,
        workspaceId,
        name: d.name,
        parentId: d.parentId,
        sortOrder: d.sortOrder,
        membersCount: membersByDepartment.get(d.id)?.size ?? 0,
        positionsCount: positionsByDepartment.get(d.id) ?? 0,
        createdAt: d.createdAt.toISOString(),
      })),
      positions: positions.map((p) => ({
        id: p.id,
        workspaceId,
        name: p.name,
        departmentId: p.departmentId,
        departmentName: p.department?.name ?? null,
        description: p.description,
        sortOrder: p.sortOrder,
        holdersCount: holdersByPosition.get(p.id)?.size ?? 0,
        createdAt: p.createdAt.toISOString(),
      })),
      branches: branches.map((b) => ({
        id: b.id,
        workspaceId,
        name: b.name,
        address: b.address,
        note: b.note,
        sortOrder: b.sortOrder,
        membersCount: membersByBranch.get(b.id)?.size ?? 0,
        createdAt: b.createdAt.toISOString(),
      })),
    };
  }

  // ============================================================
  // Отделы
  // ============================================================

  async createDepartment(
    userId: string,
    workspaceId: string,
    data: { name: string; parentId?: string | null },
  ) {
    await this.assertStaffManage(userId, workspaceId);
    const count = await this.db.staffDepartment.count({ where: { workspaceId } });
    if (count >= STAFF_LIMITS.maxDepartmentsPerWorkspace) {
      throw new BadRequestException(`Лимит отделов: ${STAFF_LIMITS.maxDepartmentsPerWorkspace}`);
    }
    if (data.parentId) await this.getDepartmentOrThrow(workspaceId, data.parentId);

    try {
      const dep = await this.db.staffDepartment.create({
        data: { workspaceId, name: data.name, parentId: data.parentId ?? null },
      });
      return { id: dep.id, name: dep.name, parentId: dep.parentId };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Отдел с таким названием уже есть');
      }
      throw e;
    }
  }

  async updateDepartment(
    userId: string,
    workspaceId: string,
    departmentId: string,
    data: { name?: string; parentId?: string | null; sortOrder?: number },
  ) {
    await this.assertStaffManage(userId, workspaceId);
    await this.getDepartmentOrThrow(workspaceId, departmentId);

    if (data.parentId !== undefined && data.parentId !== null) {
      if (data.parentId === departmentId) {
        throw new BadRequestException('Отдел не может быть родителем самого себя');
      }
      await this.getDepartmentOrThrow(workspaceId, data.parentId);
      await this.assertNoDepartmentCycle(workspaceId, departmentId, data.parentId);
    }

    try {
      await this.db.staffDepartment.update({
        where: { id: departmentId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.parentId !== undefined ? { parentId: data.parentId } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Отдел с таким названием уже есть');
      }
      throw e;
    }
    // Родитель меняет closure-членство (member отдела = member всех предков).
    if (data.parentId !== undefined) {
      await this.accessProjection.resyncWorkspaceStaff(workspaceId);
    }
  }

  async deleteDepartment(userId: string, workspaceId: string, departmentId: string) {
    await this.assertStaffManage(userId, workspaceId);
    await this.getDepartmentOrThrow(workspaceId, departmentId);
    // Дочерние отделы → в корень, должности отцепляются (FK SetNull) — мягкое удаление узла.
    await this.db.staffDepartment.delete({ where: { id: departmentId } });
    await this.accessProjection.staffEntityDeleted('department', departmentId);
    await this.accessProjection.resyncWorkspaceStaff(workspaceId);
  }

  // ============================================================
  // Должности
  // ============================================================

  async createPosition(
    userId: string,
    workspaceId: string,
    data: { name: string; departmentId?: string | null; description?: string | null },
  ) {
    await this.assertStaffManage(userId, workspaceId);
    const count = await this.db.staffPosition.count({ where: { workspaceId } });
    if (count >= STAFF_LIMITS.maxPositionsPerWorkspace) {
      throw new BadRequestException(`Лимит должностей: ${STAFF_LIMITS.maxPositionsPerWorkspace}`);
    }
    if (data.departmentId) await this.getDepartmentOrThrow(workspaceId, data.departmentId);

    try {
      const pos = await this.db.staffPosition.create({
        data: {
          workspaceId,
          name: data.name,
          departmentId: data.departmentId ?? null,
          description: data.description ?? null,
        },
      });
      return { id: pos.id, name: pos.name, departmentId: pos.departmentId };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Должность с таким названием уже есть');
      }
      throw e;
    }
  }

  async updatePosition(
    userId: string,
    workspaceId: string,
    positionId: string,
    data: {
      name?: string;
      departmentId?: string | null;
      description?: string | null;
      sortOrder?: number;
    },
  ) {
    await this.assertStaffManage(userId, workspaceId);
    const pos = await this.getPositionOrThrow(workspaceId, positionId);
    if (data.departmentId !== undefined && data.departmentId !== null) {
      await this.getDepartmentOrThrow(workspaceId, data.departmentId);
    }

    try {
      await this.db.staffPosition.update({
        where: { id: positionId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Должность с таким названием уже есть');
      }
      throw e;
    }
    // Смена отдела должности меняет производное членство её носителей в отделах.
    if (data.departmentId !== undefined && data.departmentId !== pos.departmentId) {
      await this.accessProjection.resyncWorkspaceStaff(workspaceId);
    }
  }

  async deletePosition(userId: string, workspaceId: string, positionId: string) {
    await this.assertStaffManage(userId, workspaceId);
    await this.getPositionOrThrow(workspaceId, positionId);
    const holders = await this.db.staffAssignment.count({ where: { positionId } });
    if (holders > 0) {
      throw new ConflictException('Сначала снимите назначения этой должности с сотрудников');
    }
    await this.db.staffPosition.delete({ where: { id: positionId } });
    await this.accessProjection.staffEntityDeleted('position', positionId);
  }

  // ============================================================
  // Филиалы
  // ============================================================

  async createBranch(
    userId: string,
    workspaceId: string,
    data: { name: string; address?: string | null; note?: string | null },
  ) {
    await this.assertStaffManage(userId, workspaceId);
    const count = await this.db.staffBranch.count({ where: { workspaceId } });
    if (count >= STAFF_LIMITS.maxBranchesPerWorkspace) {
      throw new BadRequestException(`Лимит филиалов: ${STAFF_LIMITS.maxBranchesPerWorkspace}`);
    }
    try {
      const br = await this.db.staffBranch.create({
        data: {
          workspaceId,
          name: data.name,
          address: data.address ?? null,
          note: data.note ?? null,
        },
      });
      return { id: br.id, name: br.name };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Филиал с таким названием уже есть');
      }
      throw e;
    }
  }

  async updateBranch(
    userId: string,
    workspaceId: string,
    branchId: string,
    data: { name?: string; address?: string | null; note?: string | null; sortOrder?: number },
  ) {
    await this.assertStaffManage(userId, workspaceId);
    await this.getBranchOrThrow(workspaceId, branchId);
    try {
      await this.db.staffBranch.update({
        where: { id: branchId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.address !== undefined ? { address: data.address } : {}),
          ...(data.note !== undefined ? { note: data.note } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Филиал с таким названием уже есть');
      }
      throw e;
    }
  }

  async deleteBranch(userId: string, workspaceId: string, branchId: string) {
    await this.assertStaffManage(userId, workspaceId);
    await this.getBranchOrThrow(workspaceId, branchId);
    const used = await this.db.staffAssignment.count({ where: { branchId } });
    if (used > 0) {
      throw new ConflictException('Сначала переведите сотрудников из этого филиала');
    }
    await this.db.staffBranch.delete({ where: { id: branchId } });
    await this.accessProjection.staffEntityDeleted('branch', branchId);
  }

  // ============================================================
  // Назначения должностей
  // ============================================================

  async assignPosition(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
    data: { positionId: string; branchId?: string | null; status?: 'training' | 'certified' },
  ) {
    await this.assertStaffManage(actorId, workspaceId);

    const targetRole = await this.getRoleOf(targetUserId, workspaceId);
    if (!targetRole) throw new NotFoundException('Этот человек не в организации');
    if (targetRole === 'contractor') {
      throw new BadRequestException('Подрядчику должности не назначаются');
    }

    const position = await this.getPositionOrThrow(workspaceId, data.positionId);
    if (data.branchId) await this.getBranchOrThrow(workspaceId, data.branchId);

    const existingCount = await this.db.staffAssignment.count({
      where: { workspaceId, userId: targetUserId },
    });
    if (existingCount >= STAFF_LIMITS.maxAssignmentsPerMember) {
      throw new BadRequestException(`Лимит должностей на сотрудника: ${STAFF_LIMITS.maxAssignmentsPerMember}`);
    }

    const dup = await this.db.staffAssignment.findFirst({
      where: {
        workspaceId,
        userId: targetUserId,
        positionId: data.positionId,
        branchId: data.branchId ?? null,
      },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Такое назначение уже есть');

    let created: AssignmentRow;
    try {
      created = await this.db.staffAssignment.create({
        data: {
          workspaceId,
          userId: targetUserId,
          positionId: data.positionId,
          branchId: data.branchId ?? null,
          status: data.status ?? 'training',
          assignedBy: actorId,
        },
        include: ASSIGNMENT_INCLUDE,
      });
    } catch (e) {
      // Гонка двух параллельных назначений — unique-индексы решают.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Такое назначение уже есть');
      }
      throw e;
    }

    await this.accessProjection.resyncWorkspaceStaff(workspaceId);

    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    this.events.emit(
      'workspace.position.assigned',
      {
        workspaceId,
        workspaceName: ws?.name ?? '',
        userId: targetUserId,
        positionName: position.name,
        branchName: created.branch?.name ?? '',
      },
      'StaffService',
    );

    return this.serializeAssignment(created);
  }

  async updateAssignment(
    actorId: string,
    workspaceId: string,
    assignmentId: string,
    data: { branchId?: string | null; status?: 'training' | 'certified' },
  ) {
    await this.assertStaffManage(actorId, workspaceId);
    const current = await this.db.staffAssignment.findUnique({
      where: { id: assignmentId },
      include: ASSIGNMENT_INCLUDE,
    });
    if (!current || current.workspaceId !== workspaceId) {
      throw new NotFoundException('Назначение не найдено');
    }
    if (data.branchId !== undefined && data.branchId !== null) {
      await this.getBranchOrThrow(workspaceId, data.branchId);
    }
    if (data.branchId !== undefined && data.branchId !== current.branchId) {
      const dup = await this.db.staffAssignment.findFirst({
        where: {
          workspaceId,
          userId: current.userId,
          positionId: current.positionId,
          branchId: data.branchId ?? null,
          id: { not: assignmentId },
        },
        select: { id: true },
      });
      if (dup) throw new ConflictException('Такое назначение уже есть');
    }

    const updated = await this.db.staffAssignment.update({
      where: { id: assignmentId },
      data: {
        ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
      include: ASSIGNMENT_INCLUDE,
    });

    await this.accessProjection.resyncWorkspaceStaff(workspaceId);

    // Аттестация (training → certified) — пока вручную; Додзё будет дергать тот же путь.
    if (data.status === 'certified' && current.status === 'training') {
      const ws = await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true },
      });
      this.events.emit(
        'workspace.position.certified',
        {
          workspaceId,
          workspaceName: ws?.name ?? '',
          userId: updated.userId,
          positionName: updated.position.name,
        },
        'StaffService',
      );
    }

    return this.serializeAssignment(updated);
  }

  async removeAssignment(actorId: string, workspaceId: string, assignmentId: string) {
    await this.assertStaffManage(actorId, workspaceId);
    const current = await this.db.staffAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, workspaceId: true },
    });
    if (!current || current.workspaceId !== workspaceId) {
      throw new NotFoundException('Назначение не найдено');
    }
    await this.db.staffAssignment.delete({ where: { id: assignmentId } });
    await this.accessProjection.resyncWorkspaceStaff(workspaceId);
  }

  /** Каскад при увольнении/выходе — вызывается WorkspacesService (без проверки прав). */
  async removeAllAssignmentsForUser(workspaceId: string, userId: string) {
    const { count } = await this.db.staffAssignment.deleteMany({
      where: { workspaceId, userId },
    });
    if (count > 0) await this.accessProjection.resyncWorkspaceStaff(workspaceId);
  }

  /**
   * Назначения всех членов воркспейса одним запросом (для ростера WorkspacesService).
   * Map<userId, StaffAssignment[]>.
   */
  async getAssignmentsByUser(workspaceId: string) {
    const rows = await this.db.staffAssignment.findMany({
      where: { workspaceId },
      include: ASSIGNMENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const byUser = new Map<string, ReturnType<StaffService['serializeAssignment']>[]>();
    for (const r of rows) {
      if (!byUser.has(r.userId)) byUser.set(r.userId, []);
      byUser.get(r.userId)!.push(this.serializeAssignment(r));
    }
    return byUser;
  }

  /** Создание назначения внутри чужой транзакции (accept-приглашения). Без проекции/событий. */
  async createAssignmentTx(
    tx: Prisma.TransactionClient,
    args: {
      workspaceId: string;
      userId: string;
      positionId: string;
      branchId?: string | null;
      assignedBy: string;
    },
  ) {
    // Справочники могли исчезнуть между отправкой приглашения и принятием — мягко скипаем.
    const position = await tx.staffPosition.findFirst({
      where: { id: args.positionId, workspaceId: args.workspaceId },
      select: { id: true },
    });
    if (!position) return false;
    if (args.branchId) {
      const branch = await tx.staffBranch.findFirst({
        where: { id: args.branchId, workspaceId: args.workspaceId },
        select: { id: true },
      });
      if (!branch) args.branchId = null;
    }
    const dup = await tx.staffAssignment.findFirst({
      where: {
        workspaceId: args.workspaceId,
        userId: args.userId,
        positionId: args.positionId,
        branchId: args.branchId ?? null,
      },
      select: { id: true },
    });
    if (dup) return false;
    await tx.staffAssignment.create({
      data: {
        workspaceId: args.workspaceId,
        userId: args.userId,
        positionId: args.positionId,
        branchId: args.branchId ?? null,
        status: 'training', // найм = стажировка по должности
        assignedBy: args.assignedBy,
      },
    });
    return true;
  }

  /** Проекция staff-рёбер воркспейса (для вызова после транзакций WorkspacesService). */
  async projectWorkspaceStaff(workspaceId: string) {
    await this.accessProjection.resyncWorkspaceStaff(workspaceId);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private serializeAssignment(a: AssignmentRow) {
    return {
      id: a.id,
      workspaceId: a.workspaceId,
      userId: a.userId,
      positionId: a.positionId,
      positionName: a.position.name,
      departmentId: a.position.departmentId,
      departmentName: a.position.department?.name ?? null,
      branchId: a.branchId,
      branchName: a.branch?.name ?? null,
      status: a.status as 'training' | 'certified',
      assignedBy: a.assignedBy,
      createdAt: a.createdAt.toISOString(),
    };
  }

  private async getRoleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  /** Любой член «команды» (Подрядчик изолирован — ростер/справочники ему закрыты). */
  private async assertTeamMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.getRoleOf(userId, workspaceId);
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    if (role === 'contractor') {
      throw new ForbiddenException('Подрядчику доступны только его задачи');
    }
    return role;
  }

  /** Управление справочниками/назначениями: владелец, админ, менеджер. */
  private async assertStaffManage(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.assertTeamMember(userId, workspaceId);
    if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
      throw new ForbiddenException('Недостаточно прав (нужен Менеджер или выше)');
    }
    return role;
  }

  private async getDepartmentOrThrow(workspaceId: string, departmentId: string) {
    const dep = await this.db.staffDepartment.findFirst({
      where: { id: departmentId, workspaceId },
    });
    if (!dep) throw new NotFoundException('Отдел не найден');
    return dep;
  }

  private async getPositionOrThrow(workspaceId: string, positionId: string) {
    const pos = await this.db.staffPosition.findFirst({
      where: { id: positionId, workspaceId },
    });
    if (!pos) throw new NotFoundException('Должность не найдена');
    return pos;
  }

  private async getBranchOrThrow(workspaceId: string, branchId: string) {
    const br = await this.db.staffBranch.findFirst({
      where: { id: branchId, workspaceId },
    });
    if (!br) throw new NotFoundException('Филиал не найден');
    return br;
  }

  /** Новый родитель не должен быть потомком отдела (иначе цикл в дереве). */
  private async assertNoDepartmentCycle(
    workspaceId: string,
    departmentId: string,
    newParentId: string,
  ) {
    const all = await this.db.staffDepartment.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true },
    });
    const parentOf = new Map(all.map((d) => [d.id, d.parentId]));
    let cursor: string | null | undefined = newParentId;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === departmentId) {
        throw new BadRequestException('Нельзя переместить отдел внутрь его собственного подотдела');
      }
      if (visited.has(cursor)) break; // защитный выход при повреждённом дереве
      visited.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
}
