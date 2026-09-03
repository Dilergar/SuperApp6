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
import { NotificationsService } from '../notifications/notifications.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { fullName } from '../../shared/utils/user-name';
import {
  ORG_ERROR_CODES,
  STAFF_LIMITS,
  WORKSPACE_ROLE_RANK,
  type OrgScopeDto,
  type WorkspaceRole,
  type StaffAssignment,
  type StaffDirectory,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';
import { OrgGraphService } from './org-graph.service';
import { OrgRightsService } from './org-rights.service';
import { buildOrgGraph, findPositionCycle, type OrgGraph } from './org-resolve';

const WS_CONTEXT = 'workspace';
type Tx = Prisma.TransactionClient;

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

/** Актор мутации: роль + область правки структуры */
interface Actor {
  userId: string;
  role: WorkspaceRole;
  scope: OrgScopeDto;
}

const coded = <T extends Error>(Ctor: new (body: unknown) => T, message: string, code: string): T =>
  new Ctor({ message, details: { code } });

/**
 * StaffService — сервис «Сотрудники» (B2B): справочники Должность/Отдел/Объект +
 * назначения должностей + оргструктура (головы, подчинение, основной объект).
 *
 * Инварианты:
 *   - Роль прав одна на организацию (UserRole) — справочники прав НЕ несут.
 *   - Членство в отделе — ПРОИЗВОДНОЕ от должности (Position.departmentId), модель
 *     штатного расписания 1С. Прямого назначения «человек → отдел» нет.
 *   - Назначение = человек × должность × ОБЪЕКТ (обязателен; пусто → основной объект);
 *     статус training|certified; ровно одно ОСНОВНОЕ место (isPrimary).
 *   - У организации всегда ≥1 объект; основной удалить нельзя (перенос флага — явно).
 *   - «Подрядчик» (contractor) изолирован: staff-эндпоинты для него закрыты, должности
 *     ему не назначаются.
 *   - Каждая мутация: проекция рёбер в core/access (position#holder, branch#member|head,
 *     department#member|head) + сброс снимка оргструктуры (OrgGraphService).
 *   - Изменение подчинения (reportsTo / голова отдела / голова объекта / отдел должности)
 *     проверяется на ПОЛНЫЙ смешанный цикл ДО записи (400 `org_cycle`).
 *   - Областные права (OrgRightsService): Менеджер+ полновластен; голова отдела правит
 *     свою ветку; голова объекта — назначения в своём объекте. Ранг субъекта уважается.
 *   - `system*`-методы прав НЕ проверяют — проверяет вызывающий (фоновый джоб hr.apply
 *     от имени создателя: областной промах там = проваленный приказ).
 */
@Injectable()
export class StaffService {
  constructor(
    private db: DatabaseService,
    private roles: RolesService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private accessProjection: AccessProjectionService,
    private chatter: ChatterService,
    private orgGraph: OrgGraphService,
    private rights: OrgRightsService,
  ) {}

  /** Имя пользователя для снапшотов хроники (удалённый/неизвестный → «Пользователь»). */
  private async chatterUserName(userId: string, tx?: Tx): Promise<string> {
    const u = await (tx ?? this.db).user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return fullName(u);
  }

  /** После КАЖДОЙ мутации структуры: проекция прав + сброс снимка графа. */
  async afterStructureChanged(workspaceId: string): Promise<void> {
    await this.accessProjection.resyncWorkspaceStaff(workspaceId);
    await this.orgGraph.invalidate(workspaceId);
  }

  /** Сброс снимка графа без проекции (смена владельца/ролей организации). */
  async invalidateOrgGraph(workspaceId: string): Promise<void> {
    await this.orgGraph.invalidate(workspaceId);
  }

  // ============================================================
  // Справочники (одним ответом — для вкладок и форм)
  // ============================================================

  async getDirectory(userId: string, workspaceId: string): Promise<StaffDirectory> {
    await this.assertTeamMember(userId, workspaceId);

    const [departments, positions, branches, assignments] = await Promise.all([
      this.db.staffDepartment.findMany({
        where: { workspaceId },
        include: { headPosition: { select: { name: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffPosition.findMany({
        where: { workspaceId },
        include: { department: { select: { name: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.staffBranch.findMany({
        where: { workspaceId },
        include: { headPosition: { select: { name: true } } },
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
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

    // Счётчики (данных мало, считаем в JS одним проходом).
    const holdersByPosition = new Map<string, Set<string>>();
    const membersByBranch = new Map<string, Set<string>>();
    const membersByDepartment = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!holdersByPosition.has(a.positionId)) holdersByPosition.set(a.positionId, new Set());
      holdersByPosition.get(a.positionId)!.add(a.userId);
      if (!membersByBranch.has(a.branchId)) membersByBranch.set(a.branchId, new Set());
      membersByBranch.get(a.branchId)!.add(a.userId);
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
        headPositionId: d.headPositionId,
        headPositionName: d.headPosition?.name ?? null,
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
        reportsToPositionId: p.reportsToPositionId,
        glyph: p.glyph,
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
        isDefault: b.isDefault,
        headPositionId: b.headPositionId,
        headPositionName: b.headPosition?.name ?? null,
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
    data: { name: string; parentId?: string | null; headPositionId?: string | null },
  ) {
    const actor = await this.actorFor(userId, workspaceId);
    // Корневой отдел — только полновластным; подотдел — в своей ветке.
    if (!data.parentId) this.requireAll(actor);
    const count = await this.db.staffDepartment.count({ where: { workspaceId } });
    if (count >= STAFF_LIMITS.maxDepartmentsPerWorkspace) {
      throw new BadRequestException(`Лимит отделов: ${STAFF_LIMITS.maxDepartmentsPerWorkspace}`);
    }
    if (data.parentId) {
      await this.getDepartmentOrThrow(workspaceId, data.parentId);
      this.requireDepartment(actor, data.parentId);
    }
    if (data.headPositionId) await this.getPositionOrThrow(workspaceId, data.headPositionId);

    let dep: { id: string; name: string; parentId: string | null; headPositionId: string | null };
    try {
      // Запись и хроника — одной транзакцией (правило канона): «отдел создан» не
      // должен теряться, если журнал упал сразу после вставки.
      dep = await this.db.$transaction(async (tx) => {
        const row = await tx.staffDepartment.create({
          data: {
            workspaceId,
            name: data.name,
            parentId: data.parentId ?? null,
            headPositionId: data.headPositionId ?? null,
          },
          select: { id: true, name: true, parentId: true, headPositionId: true },
        });
        await this.logUnit(tx, workspaceId, userId, 'created', 'отдел', row.name);
        // Цикл новый отдел замкнуть не может: у него нет ни должностей, ни подотделов.
        if (data.headPositionId) {
          await this.logHeadSet(tx, workspaceId, userId, row.id, row.name, null, data.headPositionId);
        }
        return row;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Отдел с таким названием уже есть');
      }
      throw e;
    }
    await this.afterStructureChanged(workspaceId);
    // Уведомление — только после коммита: шина at-most-once, откат её не догонит.
    if (data.headPositionId) await this.notifyHeadHolders(workspaceId, data.headPositionId, `отделом «${dep.name}»`);
    return { id: dep.id, name: dep.name, parentId: dep.parentId, headPositionId: dep.headPositionId };
  }

  async updateDepartment(
    userId: string,
    workspaceId: string,
    departmentId: string,
    data: { name?: string; parentId?: string | null; sortOrder?: number; headPositionId?: string | null },
  ) {
    const actor = await this.actorFor(userId, workspaceId);
    const current = await this.getDepartmentOrThrow(workspaceId, departmentId);
    this.requireDepartment(actor, departmentId);

    if (data.parentId !== undefined && data.parentId !== current.parentId) {
      if (data.parentId === departmentId) {
        throw new BadRequestException('Отдел не может быть родителем самого себя');
      }
      if (data.parentId === null) this.requireAll(actor); // вынос в корень
      else {
        await this.getDepartmentOrThrow(workspaceId, data.parentId);
        this.requireDepartment(actor, data.parentId); // права на ОБА отдела
        await this.assertNoDepartmentCycle(workspaceId, departmentId, data.parentId);
      }
    }
    if (data.headPositionId !== undefined && data.headPositionId !== null) {
      await this.getPositionOrThrow(workspaceId, data.headPositionId);
    }

    const structural =
      (data.parentId !== undefined && data.parentId !== current.parentId) ||
      (data.headPositionId !== undefined && data.headPositionId !== current.headPositionId);
    if (structural) {
      const cycle = await this.detectCycle(workspaceId, (g) => {
        const d = g.departmentById.get(departmentId);
        if (!d) return;
        if (data.parentId !== undefined) d.parentId = data.parentId;
        if (data.headPositionId !== undefined) d.headPositionId = data.headPositionId;
      });
      if (cycle) throw await this.cycleError(workspaceId, cycle);
    }

    const headChanged = data.headPositionId !== undefined && data.headPositionId !== current.headPositionId;
    try {
      await this.db.$transaction(async (tx) => {
        await tx.staffDepartment.update({
          where: { id: departmentId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.parentId !== undefined ? { parentId: data.parentId } : {}),
            ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
            ...(data.headPositionId !== undefined ? { headPositionId: data.headPositionId } : {}),
          },
        });
        if (headChanged) {
          await this.logHeadSet(tx, workspaceId, userId, departmentId, data.name ?? current.name, current.headPositionId, data.headPositionId ?? null);
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Отдел с таким названием уже есть');
      }
      throw e;
    }
    if (headChanged && data.headPositionId) {
      await this.notifyHeadHolders(workspaceId, data.headPositionId, `отделом «${data.name ?? current.name}»`);
    }
    // Родитель/голова меняют производные рёбра (member предков, head потомков) —
    // им нужна полная пересборка проекции. Имя и порядок рёбер не трогают, но ЛЕЖАТ
    // В СНИМКЕ (канвас берёт названия и sortOrder оттуда), поэтому снимок сбрасывается
    // ВСЕГДА: иначе переименованный отдел жил на схеме старым именем до истечения TTL
    // (15 с процесс / 600 с Redis), пока справочник уже отдавал новое.
    if (structural) await this.afterStructureChanged(workspaceId);
    else await this.orgGraph.invalidate(workspaceId);
  }

  async deleteDepartment(userId: string, workspaceId: string, departmentId: string) {
    const actor = await this.actorFor(userId, workspaceId);
    const dep = await this.getDepartmentOrThrow(workspaceId, departmentId);
    this.requireDepartment(actor, departmentId);
    const children = await this.db.staffDepartment.findMany({
      where: { workspaceId, parentId: departmentId },
      select: { id: true },
    });
    // Удаление КОРНЕВОГО отдела с подотделами поднимает их на верхний уровень —
    // а корневые отделы заводит только полновластная роль. Без этой проверки
    // руководитель ветки «создавал» корневые отделы в обход requireAll.
    if (children.length > 0 && dep.parentId === null) this.requireAll(actor);
    await this.db.$transaction(async (tx) => {
      // Подотделы переезжают к РОДИТЕЛЮ удаляемого, а не в корень (FK SetNull увёз бы
      // их наверх): ветка остаётся веткой, область правки не расширяется сама собой.
      if (children.length > 0) {
        await tx.staffDepartment.updateMany({ where: { workspaceId, parentId: departmentId }, data: { parentId: dep.parentId } });
      }
      // Должности отцепляются (FK SetNull) — мягкое удаление узла.
      await tx.staffDepartment.delete({ where: { id: departmentId } });
      await this.logUnit(tx, workspaceId, userId, 'deleted', 'отдел', dep.name);
    });
    await this.accessProjection.staffEntityDeleted('department', departmentId);
    await this.afterStructureChanged(workspaceId);
  }

  // ============================================================
  // Должности
  // ============================================================

  async createPosition(
    userId: string,
    workspaceId: string,
    data: {
      name: string;
      departmentId?: string | null;
      description?: string | null;
      reportsToPositionId?: string | null;
      glyph?: string | null;
    },
  ) {
    const actor = await this.actorFor(userId, workspaceId);
    if (data.departmentId) {
      await this.getDepartmentOrThrow(workspaceId, data.departmentId);
      this.requireDepartment(actor, data.departmentId);
    } else {
      this.requireAll(actor);
    }
    const count = await this.db.staffPosition.count({ where: { workspaceId } });
    if (count >= STAFF_LIMITS.maxPositionsPerWorkspace) {
      throw new BadRequestException(`Лимит должностей: ${STAFF_LIMITS.maxPositionsPerWorkspace}`);
    }
    if (data.reportsToPositionId) await this.getPositionOrThrow(workspaceId, data.reportsToPositionId);

    let pos: { id: string; name: string; departmentId: string | null };
    try {
      pos = await this.db.$transaction(async (tx) => {
        const row = await tx.staffPosition.create({
          data: {
            workspaceId,
            name: data.name,
            departmentId: data.departmentId ?? null,
            description: data.description ?? null,
            reportsToPositionId: data.reportsToPositionId ?? null,
            glyph: data.glyph ?? null,
          },
          select: { id: true, name: true, departmentId: true },
        });
        await this.logUnit(tx, workspaceId, userId, 'created', 'должность', row.name);
        return row;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Должность с таким названием уже есть');
      }
      throw e;
    }
    // Новая должность без держателей не меняет рёбер, но снимок графа — да.
    await this.orgGraph.invalidate(workspaceId);
    return { id: pos.id, name: pos.name, departmentId: pos.departmentId };
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
      reportsToPositionId?: string | null;
      glyph?: string | null;
    },
  ) {
    const actor = await this.actorFor(userId, workspaceId);
    const pos = await this.getPositionOrThrow(workspaceId, positionId);
    this.requirePosition(actor, pos.departmentId);

    const deptChanged = data.departmentId !== undefined && data.departmentId !== pos.departmentId;
    if (deptChanged) {
      const nextDep = data.departmentId ?? null;
      if (nextDep === null) this.requireAll(actor);
      else {
        await this.getDepartmentOrThrow(workspaceId, nextDep);
        this.requireDepartment(actor, nextDep); // перемещение — права на оба
      }
    }
    const reportsChanged = data.reportsToPositionId !== undefined && data.reportsToPositionId !== pos.reportsToPositionId;
    if (reportsChanged && data.reportsToPositionId) {
      if (data.reportsToPositionId === positionId) {
        throw new BadRequestException('Должность не может подчиняться самой себе');
      }
      await this.getPositionOrThrow(workspaceId, data.reportsToPositionId);
    }
    if (deptChanged || reportsChanged) {
      const cycle = await this.detectCycle(workspaceId, (g) => {
        const p = g.positionById.get(positionId);
        if (!p) return;
        if (deptChanged) p.departmentId = data.departmentId ?? null;
        if (reportsChanged) p.reportsToPositionId = data.reportsToPositionId ?? null;
      });
      if (cycle) throw await this.cycleError(workspaceId, cycle);
    }

    try {
      await this.db.staffPosition.update({
        where: { id: positionId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
          ...(data.reportsToPositionId !== undefined ? { reportsToPositionId: data.reportsToPositionId } : {}),
          ...(data.glyph !== undefined ? { glyph: data.glyph } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Должность с таким названием уже есть');
      }
      throw e;
    }

    if (deptChanged) {
      const [from, to] = await Promise.all([
        this.departmentName(pos.departmentId),
        this.departmentName(data.departmentId ?? null),
      ]);
      await this.chatter.log(null, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        actorName: await this.chatterUserName(userId),
        typeKey: 'staff.position_moved',
        changes: [{ field: 'department', label: 'Отдел', from, to }],
        payload: { positionId, positionName: data.name ?? pos.name },
      });
    }
    if (reportsChanged) {
      const [from, to] = await Promise.all([
        this.positionName(pos.reportsToPositionId),
        this.positionName(data.reportsToPositionId ?? null),
      ]);
      await this.chatter.log(null, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        actorName: await this.chatterUserName(userId),
        typeKey: 'staff.reports_to_set',
        changes: [{ field: 'reportsTo', label: 'Подчиняется', from, to }],
        payload: { positionId, positionName: data.name ?? pos.name },
      });
    }
    // Смена отдела должности меняет производное членство её носителей; подчинение —
    // только снимок графа.
    if (deptChanged) await this.afterStructureChanged(workspaceId);
    else await this.orgGraph.invalidate(workspaceId);
  }

  async deletePosition(userId: string, workspaceId: string, positionId: string) {
    const actor = await this.actorFor(userId, workspaceId);
    const pos = await this.getPositionOrThrow(workspaceId, positionId);
    this.requirePosition(actor, pos.departmentId);
    const holders = await this.db.staffAssignment.count({ where: { positionId } });
    if (holders > 0) {
      throw new ConflictException('Сначала снимите назначения этой должности с сотрудников');
    }
    const [headsDep, headsBr] = await Promise.all([
      this.db.staffDepartment.count({ where: { headPositionId: positionId } }),
      this.db.staffBranch.count({ where: { headPositionId: positionId } }),
    ]);
    if (headsDep + headsBr > 0) {
      throw coded(
        ConflictException,
        'Должность руководит отделом или объектом — сначала назначьте другого руководителя',
        ORG_ERROR_CODES.headInUse,
      );
    }
    await this.db.$transaction(async (tx) => {
      await tx.staffPosition.delete({ where: { id: positionId } });
      await this.logUnit(tx, workspaceId, userId, 'deleted', 'должность', pos.name);
    });
    await this.accessProjection.staffEntityDeleted('position', positionId);
    // reportsTo на неё → SetNull (откат к дереву), заместители → каскад FK.
    await this.orgGraph.invalidate(workspaceId);
  }

  // ============================================================
  // Объекты (в UI пока «Филиалы»)
  // ============================================================

  async createBranch(
    userId: string,
    workspaceId: string,
    data: { name: string; address?: string | null; note?: string | null; headPositionId?: string | null },
  ) {
    const actor = await this.actorFor(userId, workspaceId);
    this.requireAll(actor);
    const count = await this.db.staffBranch.count({ where: { workspaceId } });
    if (count >= STAFF_LIMITS.maxBranchesPerWorkspace) {
      throw new BadRequestException(`Лимит объектов: ${STAFF_LIMITS.maxBranchesPerWorkspace}`);
    }
    if (data.headPositionId) await this.getPositionOrThrow(workspaceId, data.headPositionId);
    try {
      const br = await this.db.$transaction(async (tx) => {
        const row = await tx.staffBranch.create({
          data: {
            workspaceId,
            name: data.name,
            address: data.address ?? null,
            note: data.note ?? null,
            headPositionId: data.headPositionId ?? null,
            // Первый объект организации — основной (самолечение старых организаций).
            isDefault: count === 0,
          },
        });
        await this.logUnit(tx, workspaceId, userId, 'created', 'объект', row.name);
        if (data.headPositionId) {
          await this.logBranchHeadSet(tx, workspaceId, userId, row.id, row.name, null, data.headPositionId);
        }
        return row;
      });
      await this.orgGraph.invalidate(workspaceId);
      if (data.headPositionId) await this.notifyHeadHolders(workspaceId, data.headPositionId, `объектом «${br.name}»`, br.id);
      return { id: br.id, name: br.name, isDefault: br.isDefault };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Гонка «первый объект»: партиальный уникум is_default отвергает второго
        // основного тем же кодом, что и дубль имени — сообщение подбираем по факту.
        const dupName = await this.db.staffBranch.count({ where: { workspaceId, name: data.name } });
        throw new ConflictException(dupName > 0 ? 'Объект с таким названием уже есть' : 'Основной объект уже назначен — повторите');
      }
      throw e;
    }
  }

  async updateBranch(
    userId: string,
    workspaceId: string,
    branchId: string,
    data: {
      name?: string;
      address?: string | null;
      note?: string | null;
      sortOrder?: number;
      headPositionId?: string | null;
      isDefault?: true;
    },
  ) {
    const actor = await this.actorFor(userId, workspaceId);
    this.requireAll(actor);
    const current = await this.getBranchOrThrow(workspaceId, branchId);
    if (data.headPositionId !== undefined && data.headPositionId !== null) {
      await this.getPositionOrThrow(workspaceId, data.headPositionId);
    }
    const headChanged = data.headPositionId !== undefined && data.headPositionId !== current.headPositionId;
    if (headChanged) {
      const cycle = await this.detectCycle(workspaceId, (g) => {
        const b = g.branchById.get(branchId);
        if (b) b.headPositionId = data.headPositionId ?? null;
      });
      if (cycle) throw await this.cycleError(workspaceId, cycle);
    }
    const makeDefault = data.isDefault === true && !current.isDefault;
    // Прежний основной читаем ДО транзакции: после переноса флага «предыдущего»
    // приходилось угадывать по updatedAt — снимок имени честнее догадки.
    const prevDefaultName = makeDefault
      ? (await this.db.staffBranch.findFirst({ where: { workspaceId, isDefault: true }, select: { name: true } }))?.name ?? '—'
      : null;
    const actorName = await this.chatterUserName(userId);

    try {
      await this.db.$transaction(async (tx) => {
        if (makeDefault) {
          // Перенос флага — явным действием: старый снимается в той же транзакции
          // (партиальный уникум иначе отвергнет второй основной).
          await tx.staffBranch.updateMany({ where: { workspaceId, isDefault: true }, data: { isDefault: false } });
        }
        await tx.staffBranch.update({
          where: { id: branchId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.address !== undefined ? { address: data.address } : {}),
            ...(data.note !== undefined ? { note: data.note } : {}),
            ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
            ...(data.headPositionId !== undefined ? { headPositionId: data.headPositionId } : {}),
            ...(makeDefault ? { isDefault: true } : {}),
          },
        });
        // Хроника — в той же транзакции, что и правка (правило канона).
        if (makeDefault) {
          await this.chatter.log(tx, {
            refType: 'workspace',
            refId: workspaceId,
            workspaceId,
            actorId: userId,
            actorName,
            typeKey: 'staff.default_branch_changed',
            changes: [{ field: 'defaultBranch', label: 'Основной объект', from: prevDefaultName ?? '—', to: data.name ?? current.name }],
            payload: { branchId },
          });
        }
        if (headChanged) {
          await this.logBranchHeadSet(tx, workspaceId, userId, branchId, data.name ?? current.name, current.headPositionId, data.headPositionId ?? null);
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Объект с таким названием уже есть');
      }
      throw e;
    }
    if (headChanged) {
      if (data.headPositionId) {
        await this.notifyHeadHolders(workspaceId, data.headPositionId, `объектом «${data.name ?? current.name}»`, branchId);
      }
      await this.afterStructureChanged(workspaceId);
    } else {
      // Не только перенос флага: имя, адрес и порядок объекта тоже лежат в снимке
      // (фильтр «Объект» и подписи на схеме читают его) — сброс безусловный.
      await this.orgGraph.invalidate(workspaceId);
    }
  }

  async deleteBranch(userId: string, workspaceId: string, branchId: string) {
    const actor = await this.actorFor(userId, workspaceId);
    this.requireAll(actor);
    const br = await this.getBranchOrThrow(workspaceId, branchId);
    const total = await this.db.staffBranch.count({ where: { workspaceId } });
    if (br.isDefault || total <= 1) {
      throw coded(
        ConflictException,
        'Основной объект удалить нельзя: сначала сделайте основным другой объект',
        ORG_ERROR_CODES.defaultBranch,
      );
    }
    const used = await this.db.staffAssignment.count({ where: { branchId } });
    if (used > 0) {
      throw new ConflictException('Сначала переведите сотрудников из этого объекта');
    }
    await this.db.$transaction(async (tx) => {
      await tx.staffBranch.delete({ where: { id: branchId } });
      await this.logUnit(tx, workspaceId, userId, 'deleted', 'объект', br.name);
    });
    await this.accessProjection.staffEntityDeleted('branch', branchId);
    await this.orgGraph.invalidate(workspaceId);
  }

  // ============================================================
  // Назначения должностей
  // ============================================================

  async assignPosition(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
    data: { positionId: string; branchId?: string | null; status?: 'training' | 'certified'; isPrimary?: boolean },
  ) {
    const actor = await this.actorFor(actorId, workspaceId);
    const position = await this.getPositionOrThrow(workspaceId, data.positionId);
    const branchId = await this.resolveBranchId(workspaceId, data.branchId);
    this.requireAssignment(actor, position.departmentId, branchId);
    await this.assertRankAllows(actor, workspaceId, targetUserId);
    return this.assignPositionSystem(actorId, workspaceId, targetUserId, { ...data, branchId });
  }

  /**
   * Назначение БЕЗ проверки прав — для фонового джоба КЭДО `hr.apply` (от имени создателя
   * действия: право проверено при создании приказа; областной промах в джобе означал бы
   * проваленный приказ). Право проверяет ВЫЗЫВАЮЩИЙ.
   */
  async assignPositionSystem(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
    data: { positionId: string; branchId?: string | null; status?: 'training' | 'certified'; isPrimary?: boolean },
  ) {
    const targetRole = await this.getRoleOf(targetUserId, workspaceId);
    if (!targetRole) throw new NotFoundException('Этот человек не в организации');
    if (targetRole === 'contractor') {
      throw new BadRequestException('Подрядчику должности не назначаются');
    }

    const position = await this.getPositionOrThrow(workspaceId, data.positionId);
    const branchId = await this.resolveBranchId(workspaceId, data.branchId);

    const existingCount = await this.db.staffAssignment.count({
      where: { workspaceId, userId: targetUserId },
    });
    if (existingCount >= STAFF_LIMITS.maxAssignmentsPerMember) {
      throw new BadRequestException(`Лимит должностей на сотрудника: ${STAFF_LIMITS.maxAssignmentsPerMember}`);
    }

    const dup = await this.db.staffAssignment.findFirst({
      where: { workspaceId, userId: targetUserId, positionId: data.positionId, branchId },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Такое назначение уже есть');

    // Имена для вечной записи снимаем ДО транзакции: внутри неё остаётся только запись.
    const [actorName, targetName] = await Promise.all([
      this.chatterUserName(actorId),
      this.chatterUserName(targetUserId),
    ]);
    let created: AssignmentRow;
    try {
      created = await this.db.$transaction(async (tx) => {
        // Первое назначение — основное само; явный isPrimary снимает старое основное.
        const makePrimary = existingCount === 0 || data.isPrimary === true;
        if (makePrimary && existingCount > 0) {
          await tx.staffAssignment.updateMany({
            where: { workspaceId, userId: targetUserId, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        const row = await tx.staffAssignment.create({
          data: {
            workspaceId,
            userId: targetUserId,
            positionId: data.positionId,
            branchId,
            status: data.status ?? 'training',
            isPrimary: makePrimary,
            assignedBy: actorId,
          },
          include: ASSIGNMENT_INCLUDE,
        });
        await this.chatter.log(tx, {
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName,
          typeKey: 'staff.position_assigned',
          payload: {
            targetUserId,
            targetName,
            positionName: position.name,
            // Сырой branchName — суффикс «· филиал «…»» строит renderChatterText
            // (презентация не запекается в вечную запись).
            branchName: row.branch?.name ?? null,
          },
        });
        return row;
      });
    } catch (e) {
      // Гонка двух параллельных назначений — unique-индексы решают.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Такое назначение уже есть');
      }
      throw e;
    }

    await this.afterStructureChanged(workspaceId);

    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    await this.notifications.emitEvent(
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
    await this.notifyIfHead(workspaceId, position.id, branchId, [targetUserId], ws?.name ?? '');

    return this.serializeAssignment(created);
  }

  async updateAssignment(
    actorId: string,
    workspaceId: string,
    assignmentId: string,
    data: { branchId?: string; status?: 'training' | 'certified'; isPrimary?: true },
  ) {
    const actor = await this.actorFor(actorId, workspaceId);
    const current = await this.db.staffAssignment.findUnique({
      where: { id: assignmentId },
      include: ASSIGNMENT_INCLUDE,
    });
    if (!current || current.workspaceId !== workspaceId) {
      throw new NotFoundException('Назначение не найдено');
    }
    this.requireAssignment(actor, current.position.departmentId, current.branchId);
    await this.assertRankAllows(actor, workspaceId, current.userId);
    if (data.branchId !== undefined) {
      await this.getBranchOrThrow(workspaceId, data.branchId);
      // Перевод в другой объект — права и на объект-приёмник.
      if (data.branchId !== current.branchId) this.requireAssignment(actor, current.position.departmentId, data.branchId);
    }
    if (data.branchId !== undefined && data.branchId !== current.branchId) {
      const dup = await this.db.staffAssignment.findFirst({
        where: {
          workspaceId,
          userId: current.userId,
          positionId: current.positionId,
          branchId: data.branchId,
          id: { not: assignmentId },
        },
        select: { id: true },
      });
      if (dup) throw new ConflictException('Такое назначение уже есть');
    }

    const makePrimary = data.isPrimary === true && !current.isPrimary;
    const branchChanged = data.branchId !== undefined && data.branchId !== current.branchId;
    const certified = data.status === 'certified' && current.status === 'training';
    // Имена и «прежнее основное» — до транзакции: внутри только записи.
    const [targetName, actorName] = await Promise.all([
      this.chatterUserName(current.userId),
      this.chatterUserName(actorId),
    ]);
    const prevPrimary = makePrimary
      ? await this.db.staffAssignment.findFirst({
          where: { workspaceId, userId: current.userId, isPrimary: true },
          include: ASSIGNMENT_INCLUDE,
        })
      : null;

    const updated = await this.db.$transaction(async (tx) => {
      if (makePrimary) {
        await tx.staffAssignment.updateMany({
          where: { workspaceId, userId: current.userId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const row = await tx.staffAssignment.update({
        where: { id: assignmentId },
        data: {
          ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(makePrimary ? { isPrimary: true } : {}),
        },
        include: ASSIGNMENT_INCLUDE,
      });
      // Хроника: перевод между объектами / основное место / аттестация — в той же tx.
      if (branchChanged) {
        await this.chatter.log(tx, {
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName,
          typeKey: 'staff.position_updated',
          changes: [{ field: 'branch', label: 'Объект', from: current.branch.name, to: row.branch.name }],
          payload: { targetUserId: current.userId, targetName, positionName: current.position.name },
        });
      }
      if (makePrimary) {
        await this.chatter.log(tx, {
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName,
          typeKey: 'staff.primary_changed',
          changes: [
            {
              field: 'primary',
              label: 'Основное место',
              from: prevPrimary ? `${prevPrimary.position.name} · ${prevPrimary.branch.name}` : '—',
              to: `${row.position.name} · ${row.branch.name}`,
            },
          ],
          payload: { targetUserId: current.userId, targetName },
        });
      }
      if (certified) {
        await this.chatter.log(tx, {
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName,
          typeKey: 'staff.position_certified',
          payload: { targetUserId: row.userId, targetName, positionName: row.position.name },
        });
      }
      return row;
    });

    await this.afterStructureChanged(workspaceId);

    // Аттестация (training → certified) — пока вручную; Додзё будет дергать тот же путь.
    if (certified) {
      const ws = await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true },
      });
      await this.notifications.emitEvent(
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
    const actor = await this.actorFor(actorId, workspaceId);
    const current = await this.db.staffAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, workspaceId: true, userId: true, branchId: true, position: { select: { departmentId: true } } },
    });
    if (!current || current.workspaceId !== workspaceId) {
      throw new NotFoundException('Назначение не найдено');
    }
    this.requireAssignment(actor, current.position.departmentId, current.branchId);
    await this.assertRankAllows(actor, workspaceId, current.userId);
    await this.removeAssignmentSystem(actorId, workspaceId, assignmentId);
  }

  /** Снятие БЕЗ проверки прав — для джоба КЭДО (право проверяет вызывающий). */
  async removeAssignmentSystem(actorId: string, workspaceId: string, assignmentId: string) {
    const current = await this.db.staffAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        isPrimary: true,
        position: { select: { name: true } },
      },
    });
    if (!current || current.workspaceId !== workspaceId) {
      throw new NotFoundException('Назначение не найдено');
    }
    const [actorName, targetName] = await Promise.all([
      this.chatterUserName(actorId),
      this.chatterUserName(current.userId),
    ]);
    await this.db.$transaction(async (tx) => {
      await tx.staffAssignment.delete({ where: { id: assignmentId } });
      // Удаление основного повышает следующее по createdAt — основное место есть всегда.
      if (current.isPrimary) {
        const next = await tx.staffAssignment.findFirst({
          where: { workspaceId, userId: current.userId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next) await tx.staffAssignment.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId,
        actorName,
        typeKey: 'staff.position_removed',
        payload: { targetUserId: current.userId, targetName, positionName: current.position.name },
      });
    });
    await this.afterStructureChanged(workspaceId);
  }

  /** Каскад при увольнении/выходе — вызывается WorkspacesService (без проверки прав). */
  async removeAllAssignmentsForUser(workspaceId: string, userId: string, actorId: string) {
    // Снимок должностей ДО удаления — чтобы «Журнал» получил staff.position_removed
    // по каждой (ручное снятие пишет ту же запись; на увольнении она терялась —
    // HR-аудит был неполон именно на ключевом для комплаенса событии).
    const [assignments, deputies] = await Promise.all([
      this.db.staffAssignment.findMany({
        where: { workspaceId, userId },
        select: { position: { select: { name: true } } },
      }),
      // Уволенный не остаётся заместителем: строки закрываются (след — в хронике).
      this.db.staffDeputy.findMany({
        where: { workspaceId, deputyUserId: userId },
        select: { id: true, position: { select: { name: true } } },
      }),
    ]);
    if (assignments.length === 0 && deputies.length === 0) {
      // Состав команды всё равно меняется (человек уходит) — снимок сбросить.
      await this.orgGraph.invalidate(workspaceId);
      return;
    }
    const [actorName, targetName] = await Promise.all([
      this.chatterUserName(actorId),
      this.chatterUserName(userId),
    ]);
    // Снятия и закрытые замещения — одной транзакцией с их записями в журнале:
    // именно на увольнении аудит обязан быть полным.
    await this.db.$transaction(async (tx) => {
      await tx.staffAssignment.deleteMany({ where: { workspaceId, userId } });
      if (deputies.length) {
        await tx.staffDeputy.deleteMany({ where: { id: { in: deputies.map((d) => d.id) } } });
      }
      await this.chatter.logMany(tx, [
        ...assignments.map((a) => ({
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName,
          typeKey: 'staff.position_removed' as const,
          payload: { targetUserId: userId, targetName, positionName: a.position.name },
        })),
        ...deputies.map((d) => ({
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId,
          actorName,
          typeKey: 'staff.deputy_closed' as const,
          payload: { positionName: d.position.name, deputyLabel: targetName, deputyUserId: userId },
        })),
      ]);
    });
    await this.afterStructureChanged(workspaceId);
  }

  /**
   * Назначения всех членов воркспейса одним запросом (для ростера WorkspacesService).
   * Map<userId, StaffAssignment[]>.
   */
  async getAssignmentsByUser(workspaceId: string): Promise<Map<string, StaffAssignment[]>> {
    const rows = await this.db.staffAssignment.findMany({
      where: { workspaceId },
      include: ASSIGNMENT_INCLUDE,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
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
    tx: Tx,
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
      select: { id: true, name: true },
    });
    if (!position) return false;
    let branchId: string | null = null;
    let branchName: string | null = null;
    if (args.branchId) {
      const branch = await tx.staffBranch.findFirst({
        where: { id: args.branchId, workspaceId: args.workspaceId },
        select: { id: true, name: true },
      });
      if (branch) {
        branchId = branch.id;
        branchName = branch.name;
      }
    }
    if (!branchId) {
      // Без объекта назначения не бывает: приглашение без объектов → основной.
      const def = await this.ensureDefaultBranch(args.workspaceId, tx);
      branchId = def.id;
      branchName = def.name;
    }
    const dup = await tx.staffAssignment.findFirst({
      where: { workspaceId: args.workspaceId, userId: args.userId, positionId: args.positionId, branchId },
      select: { id: true },
    });
    if (dup) return false;
    const existing = await tx.staffAssignment.count({ where: { workspaceId: args.workspaceId, userId: args.userId } });
    await tx.staffAssignment.create({
      data: {
        workspaceId: args.workspaceId,
        userId: args.userId,
        positionId: args.positionId,
        branchId,
        status: 'training', // найм = стажировка по должности
        isPrimary: existing === 0,
        assignedBy: args.assignedBy,
      },
    });
    await this.chatter.log(tx, {
      refType: 'workspace',
      refId: args.workspaceId,
      workspaceId: args.workspaceId,
      actorId: args.assignedBy,
      actorName: await this.chatterUserName(args.assignedBy, tx),
      typeKey: 'staff.position_assigned',
      payload: {
        targetUserId: args.userId,
        targetName: await this.chatterUserName(args.userId, tx),
        positionName: position.name,
        branchName: branchName ?? null,
      },
    });
    return true;
  }

  /** Проекция staff-рёбер воркспейса + сброс графа (после транзакций WorkspacesService). */
  async projectWorkspaceStaff(workspaceId: string) {
    await this.afterStructureChanged(workspaceId);
  }

  /** Основной объект организации (самолечение: у старых организаций без объектов — создать). */
  async ensureDefaultBranch(workspaceId: string, tx?: Tx): Promise<{ id: string; name: string }> {
    const db = tx ?? this.db;
    const def = await db.staffBranch.findFirst({ where: { workspaceId, isDefault: true }, select: { id: true, name: true } });
    if (def) return def;
    const any = await db.staffBranch.findFirst({
      where: { workspaceId },
      select: { id: true, name: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (any) {
      await db.staffBranch.update({ where: { id: any.id }, data: { isDefault: true } });
      return any;
    }
    const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
    const created = await db.staffBranch.create({
      data: { workspaceId, name: ws?.name ?? 'Основной объект', isDefault: true },
      select: { id: true, name: true },
    });
    return created;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private serializeAssignment(a: AssignmentRow): StaffAssignment {
    return {
      id: a.id,
      workspaceId: a.workspaceId,
      userId: a.userId,
      positionId: a.positionId,
      positionName: a.position.name,
      departmentId: a.position.departmentId,
      departmentName: a.position.department?.name ?? null,
      branchId: a.branchId,
      branchName: a.branch.name,
      isPrimary: a.isPrimary,
      status: a.status as 'training' | 'certified',
      assignedBy: a.assignedBy,
      createdAt: a.createdAt.toISOString(),
    };
  }

  private async resolveBranchId(workspaceId: string, branchId: string | null | undefined): Promise<string> {
    if (branchId) {
      await this.getBranchOrThrow(workspaceId, branchId);
      return branchId;
    }
    return (await this.ensureDefaultBranch(workspaceId)).id;
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

  /** Актор мутации структуры: команда + область (Менеджер+ = вся; голова = своя ветка/объект). */
  private async actorFor(userId: string, workspaceId: string): Promise<Actor> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const scope = await this.rights.scopeOf(userId, workspaceId, role);
    if (scope.kind === 'none') {
      throw new ForbiddenException('Недостаточно прав: структуру правят Менеджер и выше либо руководители своих отделов и объектов');
    }
    return { userId, role, scope };
  }

  /** Управление всей организацией (корневые отделы, объекты): владелец, админ, менеджер. */
  private requireAll(actor: Actor): void {
    if (actor.scope.kind !== 'all') throw OrgRightsService.forbid('Недостаточно прав (нужен Менеджер или выше)');
  }

  private requireDepartment(actor: Actor, departmentId: string): void {
    if (!OrgRightsService.coversDepartment(actor.scope, departmentId)) throw OrgRightsService.forbid();
  }

  private requirePosition(actor: Actor, departmentId: string | null): void {
    if (actor.scope.kind === 'all') return;
    if (!departmentId || !OrgRightsService.coversDepartment(actor.scope, departmentId)) throw OrgRightsService.forbid();
  }

  private requireAssignment(actor: Actor, departmentId: string | null, branchId: string | null): void {
    if (!OrgRightsService.coversAssignment(actor.scope, departmentId, branchId)) throw OrgRightsService.forbid();
  }

  /**
   * Ранг субъекта: назначать/снимать должности человеку с БОЛЕЕ ВЫСОКОЙ ролью нельзя
   * (равная — можно: голова-«Сотрудник» ведёт таких же сотрудников); Владелец — всё.
   */
  private async assertRankAllows(actor: Actor, workspaceId: string, targetUserId: string): Promise<void> {
    if (actor.role === 'owner' || actor.userId === targetUserId) return;
    const targetRole = await this.getRoleOf(targetUserId, workspaceId);
    if (!targetRole) return; // «не в организации» — отдельная ошибка ниже по пути
    if ((WORKSPACE_ROLE_RANK[targetRole] ?? 0) > (WORKSPACE_ROLE_RANK[actor.role] ?? 0)) {
      throw new ForbiddenException('Нельзя менять назначения сотрудника с более высокой ролью в организации');
    }
  }

  /** Публичный вход для чужих сервисов (Процессы): управление структурой — вся организация. */
  async assertOrgWideStaffManage(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const actor = await this.actorFor(userId, workspaceId);
    this.requireAll(actor);
    return actor.role;
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
    if (!br) throw new NotFoundException('Объект не найден');
    return br;
  }

  private async departmentName(id: string | null): Promise<string> {
    if (!id) return 'без отдела';
    const d = await this.db.staffDepartment.findUnique({ where: { id }, select: { name: true } });
    return d?.name ?? 'без отдела';
  }

  private async positionName(id: string | null): Promise<string> {
    if (!id) return 'по структуре';
    const p = await this.db.staffPosition.findUnique({ where: { id }, select: { name: true } });
    return p?.name ?? 'по структуре';
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

  /**
   * Смешанный цикл подчинения (reportsTo + дерево + голова объекта) — по ПОЛНОЙ
   * разрешённой цепочке, на живом снимке с примерённой правкой. Возвращает петлю или null.
   */
  private async detectCycle(workspaceId: string, mutate?: (g: OrgGraph) => void): Promise<string[] | null> {
    const fresh = await this.orgGraph.loadFresh(workspaceId);
    if (mutate) mutate(fresh);
    // Индексы строятся из строк — правка строк требует пересборки.
    const g = buildOrgGraph({
      workspaceId: fresh.workspaceId,
      ownerId: fresh.ownerId,
      departments: fresh.departments,
      positions: fresh.positions,
      branches: fresh.branches,
      assignments: fresh.assignments,
      deputies: fresh.deputies,
      members: fresh.members,
    });
    return findPositionCycle(g);
  }

  private async cycleError(workspaceId: string, cycle: string[]): Promise<BadRequestException> {
    const names = await this.db.staffPosition.findMany({
      where: { workspaceId, id: { in: cycle } },
      select: { id: true, name: true },
    });
    const byId = new Map(names.map((n) => [n.id, n.name]));
    const path = [...cycle, cycle[0]].map((id) => byId.get(id) ?? '?').join(' → ');
    return coded(BadRequestException, `Подчинение замыкается в цикл: ${path}`, ORG_ERROR_CODES.cycle);
  }

  /**
   * Хроника «руководитель отдела» — ВНУТРИ транзакции мутации (правило канона:
   * запись живёт ровно тогда, когда живёт сама правка). Уведомление держателям
   * шлёт вызывающий ПОСЛЕ коммита: шина at-most-once внутри транзакции недопустима.
   */
  private async logHeadSet(
    tx: Tx | null,
    workspaceId: string,
    actorId: string,
    departmentId: string,
    departmentName: string,
    fromPositionId: string | null,
    toPositionId: string | null,
  ): Promise<void> {
    const [from, to] = await Promise.all([this.headName(fromPositionId), this.headName(toPositionId)]);
    await this.chatter.log(tx, {
      refType: 'workspace',
      refId: workspaceId,
      workspaceId,
      actorId,
      actorName: await this.chatterUserName(actorId),
      typeKey: 'staff.head_set',
      changes: [{ field: 'head', label: 'Руководитель', from, to }],
      payload: { departmentId, departmentName },
    });
  }

  /** Появление/исчезновение единицы структуры — в ту же транзакцию, что и сама правка */
  private async logUnit(
    tx: Tx | null,
    workspaceId: string,
    actorId: string,
    kind: 'created' | 'deleted',
    unitLabel: 'отдел' | 'должность' | 'объект',
    unitName: string,
  ): Promise<void> {
    await this.chatter.log(tx, {
      refType: 'workspace',
      refId: workspaceId,
      workspaceId,
      actorId,
      actorName: await this.chatterUserName(actorId),
      typeKey: kind === 'created' ? 'staff.unit_created' : 'staff.unit_deleted',
      payload: { unitLabel, unitName },
    });
  }

  private async logBranchHeadSet(
    tx: Tx | null,
    workspaceId: string,
    actorId: string,
    branchId: string,
    branchName: string,
    fromPositionId: string | null,
    toPositionId: string | null,
  ): Promise<void> {
    const [from, to] = await Promise.all([this.headName(fromPositionId), this.headName(toPositionId)]);
    await this.chatter.log(tx, {
      refType: 'workspace',
      refId: workspaceId,
      workspaceId,
      actorId,
      actorName: await this.chatterUserName(actorId),
      typeKey: 'staff.branch_head_set',
      changes: [{ field: 'head', label: 'Руководитель', from, to }],
      payload: { branchId, branchName },
    });
  }

  private async headName(positionId: string | null): Promise<string> {
    if (!positionId) return 'не назначен';
    const p = await this.db.staffPosition.findUnique({ where: { id: positionId }, select: { name: true } });
    return p?.name ?? 'не назначен';
  }

  /** Уведомить держателей руководящей должности (объект — только работающих в нём). */
  private async notifyHeadHolders(workspaceId: string, positionId: string, unitLabel: string, branchId?: string): Promise<void> {
    const [holders, ws, pos] = await Promise.all([
      this.db.staffAssignment.findMany({
        where: { workspaceId, positionId, ...(branchId ? { branchId } : {}) },
        select: { userId: true },
      }),
      this.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
      this.db.staffPosition.findUnique({ where: { id: positionId }, select: { name: true } }),
    ]);
    const userIds = [...new Set(holders.map((h) => h.userId))];
    if (!userIds.length) return;
    await this.notifications.emitEvent(
      'staff.head.assigned',
      { workspaceId, workspaceName: ws?.name ?? '', userIds, unitLabel, positionName: pos?.name ?? '' },
      'StaffService',
    );
  }

  /** Человек получил должность, которая уже руководит отделом/объектом — сказать ему. */
  private async notifyIfHead(
    workspaceId: string,
    positionId: string,
    branchId: string,
    userIds: string[],
    workspaceName: string,
  ): Promise<void> {
    const [deps, brs, pos] = await Promise.all([
      this.db.staffDepartment.findMany({ where: { workspaceId, headPositionId: positionId }, select: { name: true } }),
      // Голова объекта — только держатели, работающие В ЭТОМ объекте.
      this.db.staffBranch.findMany({ where: { workspaceId, headPositionId: positionId, id: branchId }, select: { name: true } }),
      this.db.staffPosition.findUnique({ where: { id: positionId }, select: { name: true } }),
    ]);
    const units = [...deps.map((d) => `отделом «${d.name}»`), ...brs.map((b) => `объектом «${b.name}»`)];
    if (!units.length) return;
    await this.notifications.emitEvent(
      'staff.head.assigned',
      { workspaceId, workspaceName, userIds, unitLabel: units.join(', '), positionName: pos?.name ?? '' },
      'StaffService',
    );
  }
}
