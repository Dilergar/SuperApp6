import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_SCHEDULE_SETTINGS,
  OBJECT_KINDS,
  OBJECTS_ERROR_CODES,
  OBJECTS_FULL_SCOPE_ROLES,
  OBJECTS_PAYROLL_FULL_ROLES,
  OBJECT_LIMITS,
  WORKSPACE_ROLE_RANK,
  type CreateObjectInput,
  type ObjectCapsDto,
  type ObjectKind,
  type ObjectNodeDto,
  type ObjectScheduleSettingsDto,
  type ObjectTreeDto,
  type UpdateObjectInput,
  type WorkspaceRole,
  type FileDto,
  type LegalEntityLiteDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { AccessService } from '../../core/access/access.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { FilesService } from '../../core/files/files.service';
import { StaffService } from '../staff/staff.service';
import { LegalEntitiesService } from '../workspaces/legal-entities.service';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';

type Tx = Prisma.TransactionClient;

const WS_CONTEXT = 'workspace';

/** Строка объекта, достаточная для прав и сериализации. */
export interface BranchRow {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  parentId: string | null;
  ancestorIds: string[];
  depth: number;
  address: string | null;
  note: string | null;
  glyph: string | null;
  timeZone: string;
  isDefault: boolean;
  archivedAt: Date | null;
  sortOrder: number;
  legalEntityId: string | null;
  headPositionId: string | null;
  scheduleSettings: Prisma.JsonValue | null;
  createdAt: Date;
}

/**
 * Область прав зрителя на объекты организации. Считается ОДИН раз на запрос —
 * `can()` по id ребёнка промахивается мимо предков (кэш резолвится по одному узлу),
 * поэтому права по дереву собираются пересечением грантов с `[id, ...ancestorIds]`.
 */
export interface ObjectsScope {
  role: WorkspaceRole | null;
  /** owner/admin — вся организация */
  full: boolean;
  /** owner/admin — деньги везде */
  payrollFull: boolean;
  /** relation → множество id объектов, на которые есть грант (включая предков) */
  granted: Map<string, Set<string>>;
}

const EMPTY_CAPS: ObjectCapsDto = {
  view: false,
  manage: false,
  scheduleManage: false,
  attendanceMark: false,
  payrollView: false,
};

/**
 * Сервис «Объекты»: дерево физических площадок организации.
 *
 * Модель — `StaffBranch` (ключ `branch` в access/audiences/tuples сохранён): объект
 * не заводится заново, он ДОРАСТАЕТ до дерева с юрлицом, поясом и правилами смен.
 * Права наследуются вниз: назначенный на этаж — участник здания и площадки
 * (`branch#member` пишется замыканием вверх), голова здания — голова его этажей
 * (`branch#head` — замыканием вниз, см. `applyStaffDiff`).
 */
@Injectable()
export class ObjectsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly access: AccessService,
    private readonly chatter: ChatterService,
    private readonly files: FilesService,
    private readonly staff: StaffService,
    private readonly legal: LegalEntitiesService,
  ) {}

  // ============================================================
  // Права
  // ============================================================

  async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const rows = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (rows.length === 0) return null;
    return rows
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  /**
   * Область прав на объекты. `grantSetFor` НЕ скоупит по организации (рёбра не несут
   * workspaceId) — пересекаем со справочником этой организации на месте применения.
   */
  async scopeOf(userId: string, workspaceId: string, role?: WorkspaceRole | null): Promise<ObjectsScope> {
    const r = role === undefined ? await this.roleOf(userId, workspaceId) : role;
    if (!r || r === 'contractor') {
      return { role: r ?? null, full: false, payrollFull: false, granted: new Map() };
    }
    const full = (OBJECTS_FULL_SCOPE_ROLES as readonly string[]).includes(r);
    const payrollFull = (OBJECTS_PAYROLL_FULL_ROLES as readonly string[]).includes(r);
    if (full) return { role: r, full, payrollFull, granted: new Map() };

    const set = await this.access.grantSetFor(userId, 'branch');
    const granted = new Map<string, Set<string>>();
    for (const [relation, ids] of set.granted) granted.set(relation, new Set(ids));
    return { role: r, full, payrollFull, granted };
  }

  /**
   * Права на КОНКРЕТНЫЙ объект: грант на сам объект ИЛИ на любого его предка.
   * Чистая функция от области — на строку списка новых запросов не идёт.
   */
  capsFor(scope: ObjectsScope, branch: { id: string; ancestorIds: string[] }): ObjectCapsDto {
    if (scope.full) {
      return { view: true, manage: true, scheduleManage: true, attendanceMark: true, payrollView: scope.payrollFull };
    }
    if (!scope.role || scope.role === 'contractor') return { ...EMPTY_CAPS };
    const chain = [branch.id, ...branch.ancestorIds];
    const has = (relation: string) => {
      const ids = scope.granted.get(relation);
      return !!ids && chain.some((id) => ids.has(id));
    };
    const head = has('head');
    const manager = head || has('manager');
    const scheduler = manager || has('scheduler');
    const payroll = scope.payrollFull || manager || has('payroll_viewer');
    return {
      view: manager || head || has('member') || scheduler,
      manage: manager,
      scheduleManage: scheduler,
      attendanceMark: scheduler,
      payrollView: payroll,
    };
  }

  /**
   * Идентификаторы объектов, доступных зрителю ХОТЬ ПО КАКОМУ-ТО отношению —
   * для SQL-условия `b.id = ANY($ids) OR b.ancestor_ids && $ids`.
   * `null` = вся организация (owner/admin).
   */
  grantedIds(scope: ObjectsScope): string[] | null {
    if (scope.full) return null;
    const out = new Set<string>();
    for (const ids of scope.granted.values()) for (const id of ids) out.add(id);
    return [...out];
  }

  /** Объект + права; 404 без права видеть (существование объекта — тоже сведение). */
  async getOrThrow(
    userId: string,
    workspaceId: string,
    branchId: string,
    scope?: ObjectsScope,
  ): Promise<{ branch: BranchRow; caps: ObjectCapsDto; scope: ObjectsScope }> {
    const sc = scope ?? (await this.scopeOf(userId, workspaceId));
    const branch = await this.db.staffBranch.findFirst({ where: { id: branchId, workspaceId } });
    if (!branch) throw new NotFoundException('Объект не найден');
    const caps = this.capsFor(sc, branch);
    if (!caps.view) throw new NotFoundException('Объект не найден');
    return { branch, caps, scope: sc };
  }

  assertManage(caps: ObjectCapsDto): void {
    if (!caps.manage) throw new ForbiddenException('Это может только управляющий объектом');
  }

  assertSchedule(caps: ObjectCapsDto): void {
    if (!caps.scheduleManage) throw new ForbiddenException('График ведёт управляющий объектом');
  }

  // ============================================================
  // Чтение
  // ============================================================

  /** Настройки смен объекта: данные поверх дефолтов платформы. */
  scheduleSettings(branch: { scheduleSettings: Prisma.JsonValue | null }): ObjectScheduleSettingsDto {
    const raw = (branch.scheduleSettings ?? {}) as Partial<ObjectScheduleSettingsDto>;
    return { ...DEFAULT_SCHEDULE_SETTINGS, ...raw };
  }

  /**
   * Действующее юрлицо объекта: своё → ближайшего предка → головное организации.
   * Наследование считается по ancestorIds (корень первым), поэтому идём с конца.
   */
  effectiveLegalEntityId(
    branch: { legalEntityId: string | null; ancestorIds: string[] },
    byId: Map<string, { legalEntityId: string | null }>,
    headId: string | null,
  ): { id: string | null; inherited: boolean } {
    if (branch.legalEntityId) return { id: branch.legalEntityId, inherited: false };
    for (let i = branch.ancestorIds.length - 1; i >= 0; i -= 1) {
      const anc = byId.get(branch.ancestorIds[i]);
      if (anc?.legalEntityId) return { id: anc.legalEntityId, inherited: true };
    }
    return { id: headId, inherited: true };
  }

  /**
   * Дерево объектов организации, обрезанное правами. Видимыми считаются: объекты
   * с правом, ВСЕ их потомки (право наследуется вниз) и ПРЕДКИ видимых узлов —
   * иначе дерево рвётся и рядовой сотрудник не понимает, где находится его этаж.
   * Предки-«тропинки» отдаются со своими (пустыми) правами — открыть их нельзя.
   */
  async tree(userId: string, workspaceId: string, includeArchived: boolean): Promise<ObjectTreeDto> {
    const scope = await this.scopeOf(userId, workspaceId);
    if (!scope.role || scope.role === 'contractor') throw new NotFoundException('Организация не найдена');

    const all = await this.db.staffBranch.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const byId = new Map(all.map((b) => [b.id, b]));
    const headLegalId = await this.legal.headLegalEntityId(workspaceId);

    const capsById = new Map<string, ObjectCapsDto>();
    for (const b of all) capsById.set(b.id, this.capsFor(scope, b));

    // Видимые = c правом + их предки (тропинка к корню).
    const visible = new Set<string>();
    for (const b of all) {
      if (!capsById.get(b.id)?.view) continue;
      visible.add(b.id);
      for (const anc of b.ancestorIds) visible.add(anc);
    }

    const positions = await this.db.staffPosition.findMany({
      where: { workspaceId, id: { in: all.map((b) => b.headPositionId).filter((x): x is string => !!x) } },
      select: { id: true, name: true },
    });
    const positionName = new Map(positions.map((p) => [p.id, p.name]));
    const legalEntities = await this.db.legalEntity.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    const legalName = new Map(legalEntities.map((l) => [l.id, l.name]));

    const counts = await this.countsFor(workspaceId, all);

    // Порядок обхода: родитель ПЕРЕД детьми (веб рисует отступом по depth).
    const childrenOf = new Map<string | null, typeof all>();
    for (const b of all) {
      const key = b.parentId && byId.has(b.parentId) ? b.parentId : null;
      const list = childrenOf.get(key) ?? [];
      list.push(b);
      childrenOf.set(key, list);
    }
    const nodes: ObjectNodeDto[] = [];
    const walk = (parentId: string | null) => {
      for (const b of childrenOf.get(parentId) ?? []) {
        if (visible.has(b.id)) {
          nodes.push(
            this.serializeNode(b, {
              caps: capsById.get(b.id) ?? { ...EMPTY_CAPS },
              positionName,
              legalName,
              legalById: byId,
              headLegalId,
              counts,
            }),
          );
        }
        walk(b.id);
      }
    };
    walk(null);

    const wsCaps: ObjectCapsDto = {
      view: true,
      manage: scope.full,
      scheduleManage: scope.full,
      attendanceMark: scope.full,
      payrollView: scope.payrollFull,
    };
    return { nodes, caps: wsCaps, canCreate: scope.full };
  }

  /**
   * Настройки сервиса для форм веба: словари, потолки, дефолтные правила смен и
   * права зрителя на уровне организации. Одна ручка вместо четырёх констант,
   * разъезжающихся между клиентами.
   */
  async settings(
    userId: string,
    workspaceId: string,
  ): Promise<{
    kinds: typeof OBJECT_KINDS;
    limits: typeof OBJECT_LIMITS;
    defaultScheduleSettings: ObjectScheduleSettingsDto;
    legalEntities: LegalEntityLiteDto[];
    caps: ObjectCapsDto;
    canCreate: boolean;
  }> {
    const scope = await this.scopeOf(userId, workspaceId);
    if (!scope.role || scope.role === 'contractor') throw new NotFoundException('Организация не найдена');
    return {
      kinds: OBJECT_KINDS,
      limits: OBJECT_LIMITS,
      defaultScheduleSettings: { ...DEFAULT_SCHEDULE_SETTINGS },
      legalEntities: await this.legal.listLite(workspaceId),
      caps: {
        view: true,
        manage: scope.full,
        scheduleManage: scope.full,
        attendanceMark: scope.full,
        payrollView: scope.payrollFull,
      },
      canCreate: scope.full,
    };
  }

  /** Мои объекты — те, где я работаю (быстрый вход сотрудника). */
  async mine(userId: string, workspaceId: string): Promise<ObjectNodeDto[]> {
    const scope = await this.scopeOf(userId, workspaceId);
    if (!scope.role || scope.role === 'contractor') throw new NotFoundException('Организация не найдена');
    const assignments = await this.db.staffAssignment.findMany({
      // «Где я работаю» — про СЕЙЧАС: истёкшее назначение объект в списке не держит.
      where: { workspaceId, userId, ...activeAssignmentWhere() },
      select: { branchId: true },
    });
    const ids = [...new Set(assignments.map((a) => a.branchId))];
    if (ids.length === 0 && !scope.full) return [];
    const rows = await this.db.staffBranch.findMany({
      where: { workspaceId, archivedAt: null, ...(scope.full && ids.length === 0 ? {} : { id: { in: ids } }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return this.serializeMany(workspaceId, rows, scope);
  }

  async getNode(userId: string, workspaceId: string, branchId: string): Promise<ObjectNodeDto> {
    const { branch, scope } = await this.getOrThrow(userId, workspaceId, branchId);
    const [node] = await this.serializeMany(workspaceId, [branch], scope);
    return node;
  }

  /**
   * Коллеги объекта: люди, назначенные на сам объект И на его поддерево
   * («на площадке работают все, кто по этажам»). Право — `branch.view`.
   */
  async people(
    userId: string,
    workspaceId: string,
    branchId: string,
    scope?: ObjectsScope,
  ): Promise<{ userId: string; userName: string; positionName: string | null; assignmentId: string }[]> {
    const { branch } = await this.getOrThrow(userId, workspaceId, branchId, scope);
    const subtree = await this.db.staffBranch.findMany({
      where: { workspaceId, OR: [{ id: branch.id }, { ancestorIds: { has: branch.id } }] },
      select: { id: true },
    });
    const rows = await this.db.staffAssignment.findMany({
      // ТОЛЬКО действующие: закрытое назначение — история, а не коллега. Иначе
      // карточка объекта показывала «Людей: 0» и рядом список из уволенных.
      where: {
        workspaceId,
        branchId: { in: subtree.map((b) => b.id) },
        ...activeAssignmentWhere(),
      },
      select: {
        id: true,
        userId: true,
        isPrimary: true,
        position: { select: { name: true } },
        user: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const byUser = new Map<
      string,
      { userId: string; userName: string; positionName: string | null; assignmentId: string }
    >();
    for (const r of rows) {
      const name = [r.user?.lastName, r.user?.firstName].filter(Boolean).join(' ') || 'Сотрудник';
      const prev = byUser.get(r.userId);
      if (prev) {
        // Несколько должностей в объекте — перечисляем через запятую; назначением
        // строки считается ОСНОВНОЕ (на него ставится смена, если не выбрано иное).
        const names = new Set([...(prev.positionName ?? '').split(', ').filter(Boolean), r.position.name]);
        prev.positionName = [...names].join(', ');
        if (r.isPrimary) prev.assignmentId = r.id;
        continue;
      }
      byUser.set(r.userId, {
        userId: r.userId,
        userName: name,
        positionName: r.position.name,
        assignmentId: r.id,
      });
    }
    return [...byUser.values()];
  }

  // ============================================================
  // Мутации
  // ============================================================

  async create(userId: string, workspaceId: string, dto: CreateObjectInput): Promise<ObjectNodeDto> {
    const scope = await this.scopeOf(userId, workspaceId);
    // Создание объекта — структурная операция организации: owner/admin, либо
    // управляющий, добавляющий узел ВНУТРЬ своей ветки.
    let parent: BranchRow | null = null;
    if (dto.parentId) {
      const found = await this.getOrThrow(userId, workspaceId, dto.parentId, scope);
      this.assertManage(found.caps);
      parent = found.branch;
      if (parent.archivedAt) {
        throw new ConflictException({
          message: 'Родитель в архиве — верните его или выберите другой',
          details: { code: OBJECTS_ERROR_CODES.objectArchived },
        });
      }
      if (parent.depth + 1 >= OBJECT_LIMITS.maxDepth) {
        throw new ConflictException({
          message: `Глубина дерева объектов — не больше ${OBJECT_LIMITS.maxDepth}`,
          details: { code: OBJECTS_ERROR_CODES.objectTooDeep },
        });
      }
    } else if (!scope.full) {
      throw new ForbiddenException('Объект верхнего уровня заводит владелец или админ');
    }

    const count = await this.db.staffBranch.count({ where: { workspaceId } });
    if (count >= OBJECT_LIMITS.maxObjectsPerWorkspace) {
      throw new BadRequestException(`Лимит объектов: ${OBJECT_LIMITS.maxObjectsPerWorkspace}`);
    }
    if (dto.headPositionId) await this.assertPosition(workspaceId, dto.headPositionId);
    const legalEntityId = dto.legalEntityId
      ? await this.legal.resolveLegalEntityId(workspaceId, dto.legalEntityId)
      : null;

    const created = await this.db
      .$transaction(async (tx) => {
        const row = await tx.staffBranch.create({
          data: {
            workspaceId,
            name: dto.name,
            kind: dto.kind ?? 'site',
            parentId: parent?.id ?? null,
            ancestorIds: parent ? [...parent.ancestorIds, parent.id] : [],
            depth: parent ? parent.depth + 1 : 0,
            address: dto.address ?? null,
            note: dto.note ?? null,
            glyph: dto.glyph ?? null,
            legalEntityId,
            headPositionId: dto.headPositionId ?? null,
            ...(dto.timeZone ? { timeZone: dto.timeZone } : parent ? { timeZone: parent.timeZone } : {}),
            ...(dto.scheduleSettings ? { scheduleSettings: dto.scheduleSettings } : {}),
            // Первый объект организации — основной (самолечение старых организаций).
            isDefault: count === 0,
            sortOrder: count,
          },
        });
        await this.chatter.log(tx, {
          refType: 'branch',
          refId: row.id,
          workspaceId,
          actorId: userId,
          typeKey: 'branch.created',
          payload: { name: row.name },
        });
        return row;
      })
      .catch((e: unknown) => this.rethrowName(e));

    await this.staff.afterStructureChanged(workspaceId);
    const [node] = await this.serializeMany(workspaceId, [created], scope);
    return node;
  }

  async update(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: UpdateObjectInput,
  ): Promise<ObjectNodeDto> {
    const { branch, caps, scope } = await this.getOrThrow(userId, workspaceId, branchId);
    this.assertManage(caps);
    if (dto.headPositionId) await this.assertPosition(workspaceId, dto.headPositionId);
    const legalEntityId =
      dto.legalEntityId === undefined
        ? undefined
        : dto.legalEntityId === null
          ? null
          : await this.legal.resolveLegalEntityId(workspaceId, dto.legalEntityId);

    const headChanged = dto.headPositionId !== undefined && dto.headPositionId !== branch.headPositionId;
    const legalChanged = legalEntityId !== undefined && legalEntityId !== branch.legalEntityId;

    const updated = await this.db
      .$transaction(async (tx) => {
        const row = await tx.staffBranch.update({
          where: { id: branchId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.address !== undefined ? { address: dto.address } : {}),
            ...(dto.note !== undefined ? { note: dto.note } : {}),
            ...(dto.glyph !== undefined ? { glyph: dto.glyph } : {}),
            ...(dto.timeZone !== undefined ? { timeZone: dto.timeZone } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...(legalEntityId !== undefined ? { legalEntityId } : {}),
            ...(dto.headPositionId !== undefined ? { headPositionId: dto.headPositionId } : {}),
            ...(dto.scheduleSettings
              ? { scheduleSettings: { ...this.scheduleSettings(branch), ...dto.scheduleSettings } }
              : {}),
          },
        });
        // Хроника — в той же транзакции, что и правка (правило канона).
        if (headChanged) {
          const [from, to] = await Promise.all([
            this.positionName(tx, branch.headPositionId),
            this.positionName(tx, dto.headPositionId ?? null),
          ]);
          await this.chatter.log(tx, {
            refType: 'branch',
            refId: branchId,
            workspaceId,
            actorId: userId,
            typeKey: 'branch.head_set',
            changes: [{ field: 'headPositionId', label: 'Управляющая должность', from, to }],
          });
        }
        if (legalChanged) {
          const [from, to] = await Promise.all([
            this.legalEntityName(tx, branch.legalEntityId),
            this.legalEntityName(tx, legalEntityId ?? null),
          ]);
          await this.chatter.log(tx, {
            refType: 'branch',
            refId: branchId,
            workspaceId,
            actorId: userId,
            typeKey: 'branch.legal_entity_set',
            changes: [{ field: 'legalEntityId', label: 'Юрлицо', from, to }],
          });
        }
        const scalarChanges = this.scalarChanges(branch, dto);
        if (scalarChanges.length) {
          await this.chatter.log(tx, {
            refType: 'branch',
            refId: branchId,
            workspaceId,
            actorId: userId,
            typeKey: 'branch.updated',
            changes: scalarChanges,
            payload: { fieldLabel: scalarChanges.map((c) => c.label).join(', ') },
          });
        }
        return row;
      })
      .catch((e: unknown) => this.rethrowName(e));

    if (headChanged) await this.staff.afterStructureChanged(workspaceId);
    const [node] = await this.serializeMany(workspaceId, [updated], scope);
    return node;
  }

  /**
   * Перенос узла. Цикл — 409; пересчёт `ancestorIds`/`depth` ВСЕГО поддерева в
   * одной транзакции (иначе половина дерева осталась бы с чужими предками, и права
   * по предкам разъехались бы молча).
   */
  async move(userId: string, workspaceId: string, branchId: string, parentId: string | null): Promise<ObjectNodeDto> {
    const { branch, caps, scope } = await this.getOrThrow(userId, workspaceId, branchId);
    this.assertManage(caps);
    if (parentId === branch.parentId) {
      const [same] = await this.serializeMany(workspaceId, [branch], scope);
      return same;
    }

    let parent: BranchRow | null = null;
    if (parentId) {
      if (parentId === branchId) {
        throw new ConflictException({
          message: 'Объект не может быть вложен сам в себя',
          details: { code: OBJECTS_ERROR_CODES.objectCycle },
        });
      }
      const found = await this.getOrThrow(userId, workspaceId, parentId, scope);
      this.assertManage(found.caps);
      parent = found.branch;
      // Живой узел внутри закрытого — то же недопустимое состояние, что и при
      // создании (там проверка есть); в дереве он ещё и всплывает на верхний уровень.
      if (parent.archivedAt && !branch.archivedAt) {
        throw new ConflictException({
          message: 'Родитель в архиве — верните его или выберите другой',
          details: { code: OBJECTS_ERROR_CODES.objectArchived },
        });
      }
      if (parent.ancestorIds.includes(branchId)) {
        throw new ConflictException({
          message: 'Нельзя перенести объект внутрь его же потомка',
          details: { code: OBJECTS_ERROR_CODES.objectCycle },
        });
      }
    } else if (!scope.full) {
      throw new ForbiddenException('Поднять объект на верхний уровень может владелец или админ');
    }

    const subtree = await this.db.staffBranch.findMany({
      where: { workspaceId, OR: [{ id: branchId }, { ancestorIds: { has: branchId } }] },
      select: { id: true, ancestorIds: true, depth: true },
    });
    const newBase = parent ? [...parent.ancestorIds, parent.id] : [];
    const deepest = Math.max(...subtree.map((n) => n.depth)) - branch.depth;
    if (newBase.length + deepest + 1 > OBJECT_LIMITS.maxDepth) {
      throw new ConflictException({
        message: `Глубина дерева объектов — не больше ${OBJECT_LIMITS.maxDepth}`,
        details: { code: OBJECTS_ERROR_CODES.objectTooDeep },
      });
    }

    const fromLabel = branch.parentId ? (await this.branchName(this.db, branch.parentId)) : 'Верхний уровень';
    const toLabel = parent ? parent.name : 'Верхний уровень';

    const updated = await this.db.$transaction(async (tx) => {
      for (const node of subtree) {
        // Хвост предков ВНУТРИ поддерева сохраняется — меняется только «шапка».
        const tail = node.id === branchId ? [] : node.ancestorIds.slice(branch.ancestorIds.length + 1);
        const nextAncestors = node.id === branchId ? newBase : [...newBase, branchId, ...tail];
        await tx.staffBranch.update({
          where: { id: node.id },
          data: {
            ancestorIds: nextAncestors,
            depth: nextAncestors.length,
            ...(node.id === branchId ? { parentId: parent?.id ?? null } : {}),
          },
        });
      }
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'branch.moved',
        changes: [{ field: 'parentId', label: 'Родитель', from: fromLabel, to: toLabel }],
      });
      return tx.staffBranch.findUniqueOrThrow({ where: { id: branchId } });
    });

    // Перенос меняет closure прав — проекция обязана пересобраться.
    await this.staff.afterStructureChanged(workspaceId);
    const freshScope = await this.scopeOf(userId, workspaceId);
    const [node] = await this.serializeMany(workspaceId, [updated], freshScope);
    return node;
  }

  async archive(userId: string, workspaceId: string, branchId: string, restore: boolean): Promise<ObjectNodeDto> {
    const { branch, caps, scope } = await this.getOrThrow(userId, workspaceId, branchId);
    this.assertManage(caps);
    if (!restore && branch.isDefault) {
      throw new ConflictException({
        message: 'Основной объект в архив не отправляется — сначала сделайте основным другой',
        details: { code: OBJECTS_ERROR_CODES.objectInUse },
      });
    }
    // Возврат из архива не должен «оживлять» то, что закрывали ОТДЕЛЬНО и раньше.
    // Каскад ставит всем узлам поддерева ОДИН И ТОТ ЖЕ момент — по нему и отличаем
    // «закрыт вместе с родителем» от «закрыт своим решением».
    if (restore) {
      if (!branch.archivedAt) {
        const [same] = await this.serializeMany(workspaceId, [branch], scope);
        return same;
      }
      const parent = branch.parentId
        ? await this.db.staffBranch.findFirst({ where: { id: branch.parentId, workspaceId } })
        : null;
      if (parent?.archivedAt) {
        throw new ConflictException({
          message: 'Сначала верните из архива родительский объект',
          details: { code: OBJECTS_ERROR_CODES.objectArchived },
        });
      }
    }
    const stamp = branch.archivedAt;
    const updated = await this.db.$transaction(async (tx) => {
      // Архив узла закрывает и его поддерево: открытая «зона» внутри закрытого
      // здания — состояние, которого в жизни не бывает.
      await tx.staffBranch.updateMany({
        where: {
          workspaceId,
          OR: [{ id: branchId }, { ancestorIds: { has: branchId } }],
          // Архив НЕ перебивает метку у тех, кого закрыли раньше и отдельно —
          // иначе их «своя» дата терялась бы, и возврат родителя оживлял их тоже.
          // Возврат берёт ровно те строки, что закрывались ЭТИМ каскадом.
          ...(restore && stamp ? { archivedAt: stamp } : { archivedAt: null }),
        },
        data: { archivedAt: restore ? null : new Date() },
      });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'branch.archived',
        payload: { archiveVerb: restore ? 'вернул(а) из архива' : 'отправил(а) в архив', name: branch.name },
      });
      return tx.staffBranch.findUniqueOrThrow({ where: { id: branchId } });
    });
    const [node] = await this.serializeMany(workspaceId, [updated], scope);
    return node;
  }

  /**
   * Сделать объект ОСНОВНЫМ. Без этой ручки отказы «сначала сделайте основным
   * другой» (архив и удаление основного) были тупиком: флаг ставился только
   * первому объекту организации и больше не менялся.
   */
  async makeDefault(userId: string, workspaceId: string, branchId: string): Promise<ObjectNodeDto> {
    const { branch, scope } = await this.getOrThrow(userId, workspaceId, branchId);
    if (!scope.full) throw new ForbiddenException('Основной объект назначает владелец или админ');
    if (branch.archivedAt) {
      throw new ConflictException({
        message: 'Архивный объект основным не делают',
        details: { code: OBJECTS_ERROR_CODES.objectArchived },
      });
    }
    if (branch.isDefault) {
      const [same] = await this.serializeMany(workspaceId, [branch], scope);
      return same;
    }
    const updated = await this.db.$transaction(async (tx) => {
      // Снятие старого и установка нового — ОДНОЙ транзакцией: двух основных
      // объектов в организации быть не должно ни на миг.
      await tx.staffBranch.updateMany({ where: { workspaceId, isDefault: true }, data: { isDefault: false } });
      const row = await tx.staffBranch.update({ where: { id: branchId }, data: { isDefault: true } });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'branch.updated',
        changes: [{ field: 'isDefault', label: 'Основной объект', from: 'нет', to: 'да' }],
        payload: { fieldLabel: 'Основной объект' },
      });
      return row;
    });
    const [node] = await this.serializeMany(workspaceId, [updated], scope);
    return node;
  }

  /** Удаление — только пустого узла: дети, люди и активы держат объект (409). */
  async remove(userId: string, workspaceId: string, branchId: string): Promise<void> {
    const { branch, caps } = await this.getOrThrow(userId, workspaceId, branchId);
    this.assertManage(caps);
    if (branch.isDefault) {
      throw new ConflictException({
        message: 'Основной объект удалить нельзя: сначала сделайте основным другой',
        details: { code: OBJECTS_ERROR_CODES.objectInUse },
      });
    }
    const children = await this.db.staffBranch.count({ where: { parentId: branchId } });
    if (children > 0) {
      throw new ConflictException({
        message: 'Внутри есть вложенные объекты — перенесите их',
        details: { code: OBJECTS_ERROR_CODES.objectHasChildren },
      });
    }
    // Удаляем только ПУСТОЙ узел. Внешние ключи штатки, смен и оборудования стоят
    // на Restrict: без этих проверок Prisma отдаёт P2003, а он в общем фильтре не
    // разобран — пользователь получал «Внутреннюю ошибку сервера» вместо отказа.
    const [used, staffing, shifts, assets] = await Promise.all([
      this.db.staffAssignment.count({ where: { branchId } }),
      this.db.staffingPosition.count({ where: { branchId } }),
      this.db.shift.count({ where: { branchId } }),
      this.db.asset.count({ where: { branchId } }),
    ]);
    if (used > 0) {
      throw new ConflictException({
        message: 'Сначала переведите сотрудников из этого объекта',
        details: { code: OBJECTS_ERROR_CODES.objectInUse },
      });
    }
    if (staffing > 0) {
      throw new ConflictException({
        message: 'В объекте есть штатные единицы — уберите их из штатного расписания',
        details: { code: OBJECTS_ERROR_CODES.objectInUse },
      });
    }
    if (shifts > 0) {
      throw new ConflictException({
        message: 'В объекте есть смены — историю графика удалить нельзя, отправьте объект в архив',
        details: { code: OBJECTS_ERROR_CODES.objectInUse },
      });
    }
    if (assets > 0) {
      throw new ConflictException({
        message: 'В объекте есть оборудование — переместите его в другой объект',
        details: { code: OBJECTS_ERROR_CODES.objectInUse },
      });
    }
    await this.db.$transaction(async (tx) => {
      await tx.staffBranch.delete({ where: { id: branchId } });
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        typeKey: 'staff.unit_deleted',
        payload: { unitLabel: 'объект', unitName: branch.name },
      });
    });
    await this.staff.afterStructureChanged(workspaceId);
  }

  // ============================================================
  // Файлы объекта (движок core/files; своих таблиц нет)
  // ============================================================

  async listFiles(userId: string, workspaceId: string, branchId: string): Promise<FileDto[]> {
    await this.getOrThrow(userId, workspaceId, branchId);
    const byRef = await this.files.listLinked('branch', [branchId]);
    return byRef.get(branchId) ?? [];
  }

  async attachFile(userId: string, workspaceId: string, branchId: string, fileId: string): Promise<void> {
    const { caps } = await this.getOrThrow(userId, workspaceId, branchId);
    this.assertManage(caps);
    await this.files.linkFile(userId, fileId, 'branch', branchId);
  }

  async detachFile(userId: string, workspaceId: string, branchId: string, fileId: string): Promise<void> {
    const { caps } = await this.getOrThrow(userId, workspaceId, branchId);
    this.assertManage(caps);
    await this.files.unlinkFile(userId, fileId, 'branch', branchId);
  }

  // ============================================================
  // Сериализация
  // ============================================================

  async serializeMany(
    workspaceId: string,
    rows: BranchRow[],
    scope: ObjectsScope,
  ): Promise<ObjectNodeDto[]> {
    if (rows.length === 0) return [];
    const ancestorIds = new Set<string>();
    for (const r of rows) for (const a of r.ancestorIds) ancestorIds.add(a);
    const [ancestors, positions, legalEntities, headLegalId, counts] = await Promise.all([
      ancestorIds.size
        ? this.db.staffBranch.findMany({
            where: { id: { in: [...ancestorIds] } },
            select: { id: true, legalEntityId: true, name: true },
          })
        : Promise.resolve([]),
      this.db.staffPosition.findMany({
        where: { workspaceId, id: { in: rows.map((r) => r.headPositionId).filter((x): x is string => !!x) } },
        select: { id: true, name: true },
      }),
      this.db.legalEntity.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
      this.legal.headLegalEntityId(workspaceId),
      this.countsFor(workspaceId, rows),
    ]);
    const byId = new Map<string, { legalEntityId: string | null }>();
    for (const a of ancestors) byId.set(a.id, a);
    for (const r of rows) byId.set(r.id, r);
    const positionName = new Map(positions.map((p) => [p.id, p.name]));
    const legalName = new Map(legalEntities.map((l) => [l.id, l.name]));
    return rows.map((r) =>
      this.serializeNode(r, {
        caps: this.capsFor(scope, r),
        positionName,
        legalName,
        legalById: byId,
        headLegalId,
        counts,
      }),
    );
  }

  private serializeNode(
    b: BranchRow,
    ctx: {
      caps: ObjectCapsDto;
      positionName: Map<string, string>;
      legalName: Map<string, string>;
      legalById: Map<string, { legalEntityId: string | null }>;
      headLegalId: string | null;
      counts: Map<string, { members: number; staffing: number; assets: number }>;
    },
  ): ObjectNodeDto {
    const eff = this.effectiveLegalEntityId(b, ctx.legalById, ctx.headLegalId);
    const c = ctx.counts.get(b.id) ?? { members: 0, staffing: 0, assets: 0 };
    return {
      id: b.id,
      workspaceId: b.workspaceId,
      name: b.name,
      kind: b.kind as ObjectKind,
      parentId: b.parentId,
      ancestorIds: b.ancestorIds,
      depth: b.depth,
      address: b.address,
      note: b.note,
      glyph: b.glyph,
      timeZone: b.timeZone,
      isDefault: b.isDefault,
      archivedAt: b.archivedAt ? b.archivedAt.toISOString() : null,
      sortOrder: b.sortOrder,
      legalEntityId: b.legalEntityId,
      effectiveLegalEntityId: eff.id,
      effectiveLegalEntityName: eff.id ? (ctx.legalName.get(eff.id) ?? null) : null,
      legalEntityInherited: eff.inherited,
      headPositionId: b.headPositionId,
      headPositionName: b.headPositionId ? (ctx.positionName.get(b.headPositionId) ?? null) : null,
      membersCount: c.members,
      staffingCount: c.staffing,
      assetsCount: c.assets,
      scheduleSettings: this.scheduleSettings(b),
      caps: ctx.caps,
      createdAt: b.createdAt.toISOString(),
    };
  }

  /**
   * Счётчики обзора для набора узлов: люди — по ВСЕМУ поддереву (на площадке
   * «работает 40 человек», даже если сидят по этажам).
   */
  private async countsFor(
    workspaceId: string,
    rows: { id: string; ancestorIds: string[] }[],
  ): Promise<Map<string, { members: number; staffing: number; assets: number }>> {
    const out = new Map<string, { members: number; staffing: number; assets: number }>();
    if (rows.length === 0) return out;
    for (const r of rows) out.set(r.id, { members: 0, staffing: 0, assets: 0 });
    const ids = rows.map((r) => r.id);

    // Считаем ТОЛЬКО по нужным веткам, а не по всей организации: карточка одного
    // склада читала обе таблицы целиком (на сети из сотен объектов и тысяч
    // сотрудников это заметно сразу).
    const scopeWhere = { OR: [{ id: { in: ids } }, { ancestorIds: { hasSome: ids } }] };
    const branches = await this.db.staffBranch.findMany({
      where: { workspaceId, ...scopeWhere },
      select: { id: true, ancestorIds: true },
    });
    const scopeIds = branches.map((b) => b.id);
    const [assignments, staffing, assets] = await Promise.all([
      this.db.staffAssignment.findMany({
        where: { workspaceId, branchId: { in: scopeIds }, ...activeAssignmentWhere() },
        select: { userId: true, branchId: true },
      }),
      this.db.staffingPosition.groupBy({
        by: ['branchId'],
        where: { workspaceId, branchId: { in: ids }, archivedAt: null },
        _count: { _all: true },
      }),
      this.db.asset.groupBy({
        by: ['branchId'],
        where: { workspaceId, branchId: { in: ids }, archivedAt: null },
        _count: { _all: true },
      }),
    ]);
    const chainOf = new Map(branches.map((b) => [b.id, [b.id, ...b.ancestorIds]]));
    const peopleByBranch = new Map<string, Set<string>>();
    for (const a of assignments) {
      for (const scopeId of chainOf.get(a.branchId) ?? [a.branchId]) {
        if (!out.has(scopeId)) continue;
        const set = peopleByBranch.get(scopeId) ?? new Set<string>();
        set.add(a.userId);
        peopleByBranch.set(scopeId, set);
      }
    }
    // Штатка и оборудование считаются ПО САМОМУ объекту (не по поддереву): это
    // его собственные строки, а не «сколько всего внутри».
    const staffingBy = new Map(staffing.map((r) => [r.branchId, r._count._all]));
    const assetsBy = new Map(assets.map((r) => [r.branchId, r._count._all]));
    for (const id of ids) {
      const cur = out.get(id)!;
      cur.members = peopleByBranch.get(id)?.size ?? 0;
      cur.staffing = staffingBy.get(id) ?? 0;
      cur.assets = assetsBy.get(id) ?? 0;
    }
    return out;
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  private scalarChanges(
    before: BranchRow,
    dto: UpdateObjectInput,
  ): { field: string; label: string; from: string | null; to: string | null }[] {
    const spec: [keyof UpdateObjectInput, string, (b: BranchRow) => string | null][] = [
      ['name', 'Название', (b) => b.name],
      ['kind', 'Вид', (b) => b.kind],
      ['address', 'Адрес', (b) => b.address],
      ['timeZone', 'Часовой пояс', (b) => b.timeZone],
      ['note', 'Заметка', (b) => b.note],
    ];
    // ВСЕ изменённые поля, а не первое: поменяли имя и адрес — в ленте обязаны
    // остаться оба, иначе хроника молча теряет половину правки.
    const out: { field: string; label: string; from: string | null; to: string | null }[] = [];
    for (const [key, label, read] of spec) {
      const next = dto[key];
      if (next === undefined) continue;
      const from = read(before);
      const to = (next ?? null) as string | null;
      if (from !== to) out.push({ field: key as string, label, from, to });
    }
    return out;
  }

  private async positionName(tx: Tx, id: string | null): Promise<string | null> {
    if (!id) return null;
    const row = await tx.staffPosition.findUnique({ where: { id }, select: { name: true } });
    return row?.name ?? null;
  }

  private async legalEntityName(tx: Tx, id: string | null): Promise<string | null> {
    if (!id) return null;
    const row = await tx.legalEntity.findUnique({ where: { id }, select: { name: true } });
    return row?.name ?? null;
  }

  private async branchName(db: DatabaseService, id: string): Promise<string> {
    const row = await db.staffBranch.findUnique({ where: { id }, select: { name: true } });
    return row?.name ?? '—';
  }

  private async assertPosition(workspaceId: string, positionId: string): Promise<void> {
    const found = await this.db.staffPosition.count({ where: { id: positionId, workspaceId } });
    if (!found) throw new BadRequestException('Должность не найдена в этой организации');
  }

  private rethrowName(e: unknown): never {
    if ((e as { code?: string })?.code === 'P2002') {
      throw new ConflictException('Объект с таким названием уже есть');
    }
    throw e as Error;
  }
}
