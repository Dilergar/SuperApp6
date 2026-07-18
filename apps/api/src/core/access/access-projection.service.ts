import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { AccessService } from './access.service';
import { RelationTupleInput } from './access.types';

// Workspace UserRole values → `workspace` relation in ACCESS_SCHEMA.
// staff & trainee are both employees → `member` (рядовое членство; Стажёр отличается
// только лестницей прав в сервисах, не движком). `contractor` (Подрядчик) намеренно
// НЕ проецируется — он изолирован до явных грантов своих задач/чатов (Коллаб-модель).
const WS_ROLE_RELATION: Record<string, string> = {
  owner: 'owner',
  admin: 'admin',
  manager: 'manager',
  staff: 'member',
  trainee: 'member',
};
const WS_PROJECTED_ROLES = Object.keys(WS_ROLE_RELATION);
const WS_RELATIONS = [...new Set(Object.values(WS_ROLE_RELATION))];

interface DiffResult {
  added: number;
  removed: number;
  total: number;
}

/**
 * Phase 1 — projection: keeps the access engine's tuple store in sync with the
 * authoritative DOMAIN tables (Circle membership, workspace UserRoles). Domain tables
 * stay the source of truth; access-relevant EDGES are mirrored into RelationTuple.
 *
 * Strategy: best-effort live hooks (called from CirclesService / RolesService) for low
 * latency + drift-free reconcile() (cron + one-time backfill) as the safety net. All
 * live hooks are non-fatal (a projection failure never breaks the domain operation —
 * the reconciler will repair it). Nothing READS these tuples for decisions until
 * Phase 2, so a transient drift window is harmless.
 */
@Injectable()
export class AccessProjectionService {
  private readonly logger = new Logger(AccessProjectionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}

  // ------------------------------------------------------------
  // Circle membership — live hooks (best-effort)
  // ------------------------------------------------------------

  async circleMemberAdded(circleId: string, memberUserId: string): Promise<void> {
    await this.safe(() =>
      this.access.grant({
        resourceType: 'circle',
        resourceId: circleId,
        relation: 'member',
        subjectType: 'user',
        subjectId: memberUserId,
      }),
    );
  }

  async circleMemberRemoved(circleId: string, memberUserId: string): Promise<void> {
    await this.safe(() =>
      this.access.revoke({
        resourceType: 'circle',
        resourceId: circleId,
        relation: 'member',
        subjectType: 'user',
        subjectId: memberUserId,
      }),
    );
  }

  async circleDeleted(circleId: string): Promise<void> {
    await this.safe(() => this.access.revokeResource('circle', circleId));
  }

  // ------------------------------------------------------------
  // Workspace roles — re-sync one user's role tuples (the single chokepoint all
  // role changes funnel through: RolesService + WorkspacesService transactional writes).
  // ------------------------------------------------------------

  async resyncUserWorkspaceRoles(userId: string): Promise<void> {
    await this.safe(async () => {
      const roles = await this.db.userRole.findMany({
        where: { userId, context: 'workspace', isActive: true, tenantId: { not: null }, role: { in: WS_PROJECTED_ROLES } },
        select: { tenantId: true, role: true },
      });
      const desired: RelationTupleInput[] = [];
      const seen = new Set<string>();
      for (const r of roles) {
        if (!r.tenantId) continue;
        const relation = WS_ROLE_RELATION[r.role];
        const k = `${r.tenantId}#${relation}`;
        if (seen.has(k)) continue; // staff+trainee → один и тот же member-tuple
        seen.add(k);
        desired.push({ resourceType: 'workspace', resourceId: r.tenantId, relation, subjectType: 'user', subjectId: userId });
      }
      const existing = await this.db.relationTuple.findMany({
        where: { subjectType: 'user', subjectId: userId, resourceType: 'workspace', relation: { in: WS_RELATIONS } },
        select: { id: true, resourceId: true, relation: true },
      });
      await this.applyDiff(
        desired,
        existing.map((e) => ({
          id: e.id,
          key: this.key({ resourceType: 'workspace', resourceId: e.resourceId, relation: e.relation, subjectType: 'user', subjectId: userId }),
        })),
      );
    });
  }

  // ------------------------------------------------------------
  // Full reconcile — cron safety net + one-time backfill of existing data
  // ------------------------------------------------------------

  async reconcile(): Promise<{ circle: DiffResult; workspace: DiffResult; circleCalendar: DiffResult; staff: DiffResult }> {
    return {
      circle: await this.reconcileCircles(),
      workspace: await this.reconcileWorkspaceRoles(),
      circleCalendar: await this.reconcileCircleCalendar(),
      staff: await this.reconcileStaff(),
    };
  }

  /**
   * Additive backfill of shop access edges into tuples: shop ownership + showcase→shop parent
   * pointers (shares & staff are tuple-native — written directly by ShopService, not backfilled).
   * ADDITIVE only (never deletes); deletions handled by live revokes (delete showcase / unshare).
   */
  async backfillShops(): Promise<{ added: number }> {
    // Keyset-батчи (таблицы масштаба «пользователи», но не материализуем целиком).
    const BATCH = 1000;
    let added = 0;

    let shopCursor: string | undefined;
    for (;;) {
      const shops = await this.db.shop.findMany({
        select: { id: true, ownerType: true, ownerId: true },
        orderBy: { id: 'asc' },
        ...(shopCursor ? { cursor: { id: shopCursor }, skip: 1 } : {}),
        take: BATCH,
      });
      if (!shops.length) break;
      shopCursor = shops[shops.length - 1].id;
      const tuples: RelationTupleInput[] = [];
      for (const s of shops) {
        if (s.ownerType === 'user') {
          tuples.push({ resourceType: 'shop', resourceId: s.id, relation: 'owner', subjectType: 'user', subjectId: s.ownerId });
        } else {
          // workspace-owned: the workspace admins (⊇ owner) manage the shop
          tuples.push({ resourceType: 'shop', resourceId: s.id, relation: 'manager', subjectType: 'workspace', subjectId: s.ownerId, subjectRelation: 'admin' });
        }
      }
      await this.access.grantMany(tuples);
      added += tuples.length;
      if (shops.length < BATCH) break;
    }

    let scCursor: string | undefined;
    for (;;) {
      const showcases = await this.db.showcase.findMany({
        select: { id: true, shopId: true },
        orderBy: { id: 'asc' },
        ...(scCursor ? { cursor: { id: scCursor }, skip: 1 } : {}),
        take: BATCH,
      });
      if (!showcases.length) break;
      scCursor = showcases[showcases.length - 1].id;
      // Legacy ShowcaseShare + UserRole(shop/showcase) staff are dropped — shares & staff are
      // tuple-native now (written directly by ShopService). Only ownership + parent are projected.
      const tuples: RelationTupleInput[] = showcases.map((sc) => ({
        resourceType: 'showcase',
        resourceId: sc.id,
        relation: 'parent',
        subjectType: 'shop',
        subjectId: sc.shopId,
      }));
      await this.access.grantMany(tuples);
      added += tuples.length;
      if (showcases.length < BATCH) break;
    }

    return { added };
  }

  // ------------------------------------------------------------
  // Calendar sharing (Phase 2 Calendar migration)
  //   personal share  → calendar:<owner>#<level>_viewer@user
  //   per-Group share → calendar:<owner>#<level>_viewer@circle#member  (level = Circle.calendarVisibility)
  // ------------------------------------------------------------

  /** A Group's calendar visibility changed (set in CirclesService.updateCircle). */
  async circleCalendarVisibilityChanged(circleId: string, ownerId: string, level: string): Promise<void> {
    await this.safe(async () => {
      const subject = { subjectType: 'circle', subjectId: circleId, subjectRelation: 'member' } as const;
      // Clear any prior level, then set the new one ('none' = cleared).
      await this.access.revoke({ resourceType: 'calendar', resourceId: ownerId, relation: 'busy_viewer', ...subject });
      await this.access.revoke({ resourceType: 'calendar', resourceId: ownerId, relation: 'detailed_viewer', ...subject });
      if (level === 'busy' || level === 'detailed') {
        await this.access.grant({ resourceType: 'calendar', resourceId: ownerId, relation: level === 'detailed' ? 'detailed_viewer' : 'busy_viewer', ...subject });
      }
    });
  }

  /** Additive backfill: Circle.calendarVisibility → calendar group tuples (personal shares are tuple-native). */
  async backfillCalendar(): Promise<{ added: number }> {
    const BATCH = 1000;
    let added = 0;
    let cursor: string | undefined;
    for (;;) {
      // Legacy CalendarShare is dropped — personal calendar shares are tuple-native now (CalendarService).
      const circles = await this.db.circle.findMany({
        where: { calendarVisibility: { in: ['busy', 'detailed'] } },
        select: { id: true, ownerId: true, calendarVisibility: true },
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: BATCH,
      });
      if (!circles.length) break;
      cursor = circles[circles.length - 1].id;
      const tuples: RelationTupleInput[] = circles.map((c) => ({
        resourceType: 'calendar',
        resourceId: c.ownerId,
        relation: c.calendarVisibility === 'detailed' ? 'detailed_viewer' : 'busy_viewer',
        subjectType: 'circle',
        subjectId: c.id,
        subjectRelation: 'member',
      }));
      await this.access.grantMany(tuples);
      added += tuples.length;
      if (circles.length < BATCH) break;
    }
    return { added };
  }

  /** Diff-reconcile the per-Group calendar tuples against Circle.calendarVisibility (drift self-heal). */
  private async reconcileCircleCalendar(): Promise<DiffResult> {
    const circles = await this.db.circle.findMany({
      where: { calendarVisibility: { in: ['busy', 'detailed'] } },
      select: { id: true, ownerId: true, calendarVisibility: true },
    });
    const desired: RelationTupleInput[] = circles.map((c) => ({
      resourceType: 'calendar',
      resourceId: c.ownerId,
      relation: c.calendarVisibility === 'detailed' ? 'detailed_viewer' : 'busy_viewer',
      subjectType: 'circle',
      subjectId: c.id,
      subjectRelation: 'member',
    }));
    const existing = await this.db.relationTuple.findMany({
      where: { resourceType: 'calendar', relation: { in: ['busy_viewer', 'detailed_viewer'] }, subjectType: 'circle' },
      select: { id: true, resourceId: true, relation: true, subjectId: true },
    });
    return this.applyDiff(
      desired,
      existing.map((e) => ({
        id: e.id,
        key: this.key({ resourceType: 'calendar', resourceId: e.resourceId, relation: e.relation, subjectType: 'circle', subjectId: e.subjectId, subjectRelation: 'member' }),
      })),
    );
  }

  private async reconcileCircles(): Promise<DiffResult> {
    const rows = await this.db.circleMembership.findMany({
      select: {
        circleId: true,
        circle: { select: { ownerId: true } },
        contactLink: { select: { userAId: true, userBId: true } },
      },
    });
    const desired: RelationTupleInput[] = rows.map((r) => {
      const ownerId = r.circle.ownerId;
      const memberId = r.contactLink.userAId === ownerId ? r.contactLink.userBId : r.contactLink.userAId;
      return { resourceType: 'circle', resourceId: r.circleId, relation: 'member', subjectType: 'user', subjectId: memberId };
    });
    const existing = await this.db.relationTuple.findMany({
      where: { resourceType: 'circle', relation: 'member', subjectType: 'user' },
      select: { id: true, resourceId: true, subjectId: true },
    });
    return this.applyDiff(
      desired,
      existing.map((e) => ({
        id: e.id,
        key: this.key({ resourceType: 'circle', resourceId: e.resourceId, relation: 'member', subjectType: 'user', subjectId: e.subjectId }),
      })),
    );
  }

  private async reconcileWorkspaceRoles(): Promise<DiffResult> {
    const roles = await this.db.userRole.findMany({
      where: { context: 'workspace', isActive: true, tenantId: { not: null }, role: { in: WS_PROJECTED_ROLES } },
      select: { tenantId: true, role: true, userId: true },
    });
    const desired: RelationTupleInput[] = [];
    const seen = new Set<string>();
    for (const r of roles) {
      if (!r.tenantId) continue;
      const relation = WS_ROLE_RELATION[r.role];
      const k = `${r.tenantId}#${relation}@${r.userId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      desired.push({ resourceType: 'workspace', resourceId: r.tenantId, relation, subjectType: 'user', subjectId: r.userId });
    }
    const existing = await this.db.relationTuple.findMany({
      where: { resourceType: 'workspace', relation: { in: WS_RELATIONS }, subjectType: 'user' },
      select: { id: true, resourceId: true, relation: true, subjectId: true },
    });
    return this.applyDiff(
      desired,
      existing.map((e) => ({
        id: e.id,
        key: this.key({ resourceType: 'workspace', resourceId: e.resourceId, relation: e.relation, subjectType: 'user', subjectId: e.subjectId }),
      })),
    );
  }

  // ------------------------------------------------------------
  // Staff («Сотрудники») — назначения должностей → рёбра трёх осей оргструктуры:
  //   position:<id>#holder@user
  //   branch:<id>#member@user
  //   department:<id и все предки>#member@user   (CLOSURE: грант на отдел достаёт
  //                                               и сотрудников подотделов)
  // Членство в отделе ПРОИЗВОДНОЕ: assignment → position.departmentId → ancestors.
  // ------------------------------------------------------------

  /** Re-sync всех staff-рёбер одного воркспейса (вызывается после каждой мутации StaffService). */
  async resyncWorkspaceStaff(workspaceId: string): Promise<void> {
    await this.safe(async () => {
      await this.applyStaffDiff(workspaceId);
    });
  }

  /** Удалённый справочник (отдел/должность/филиал) — снять все его tuples. */
  async staffEntityDeleted(resourceType: 'department' | 'position' | 'branch', id: string): Promise<void> {
    await this.safe(() => this.access.revokeResource(resourceType, id));
  }

  /** Cron-сверка staff-рёбер по ВСЕМ воркспейсам (дрейф-самолечение + бэкфилл). */
  private async reconcileStaff(): Promise<DiffResult> {
    return this.applyStaffDiff(null);
  }

  private async applyStaffDiff(workspaceId: string | null): Promise<DiffResult> {
    const wsWhere = workspaceId ? { workspaceId } : {};
    const [assignments, departments] = await Promise.all([
      this.db.staffAssignment.findMany({
        where: wsWhere,
        select: {
          userId: true,
          positionId: true,
          branchId: true,
          position: { select: { departmentId: true } },
        },
      }),
      this.db.staffDepartment.findMany({
        where: wsWhere,
        select: { id: true, parentId: true },
      }),
    ]);

    const parentOf = new Map(departments.map((d) => [d.id, d.parentId]));
    const desiredByKey = new Map<string, RelationTupleInput>();
    const put = (t: RelationTupleInput) => desiredByKey.set(this.key(t), t);

    for (const a of assignments) {
      put({ resourceType: 'position', resourceId: a.positionId, relation: 'holder', subjectType: 'user', subjectId: a.userId });
      if (a.branchId) {
        put({ resourceType: 'branch', resourceId: a.branchId, relation: 'member', subjectType: 'user', subjectId: a.userId });
      }
      // Отдел + все предки (closure; visited-гард на случай повреждённого дерева).
      let dep = a.position.departmentId;
      const visited = new Set<string>();
      while (dep && !visited.has(dep)) {
        visited.add(dep);
        put({ resourceType: 'department', resourceId: dep, relation: 'member', subjectType: 'user', subjectId: a.userId });
        dep = parentOf.get(dep) ?? null;
      }
    }

    // Скоуп существующих tuples: при per-workspace resync — только сущности этого
    // воркспейса (tuples не несут workspaceId); при глобальной сверке — все три типа.
    let existingWhere: Prisma.RelationTupleWhereInput;
    if (workspaceId) {
      const [posIds, brIds, depIds] = await Promise.all([
        this.db.staffPosition.findMany({ where: { workspaceId }, select: { id: true } }),
        this.db.staffBranch.findMany({ where: { workspaceId }, select: { id: true } }),
        this.db.staffDepartment.findMany({ where: { workspaceId }, select: { id: true } }),
      ]);
      existingWhere = {
        OR: [
          { resourceType: 'position', resourceId: { in: posIds.map((x) => x.id) } },
          { resourceType: 'branch', resourceId: { in: brIds.map((x) => x.id) } },
          { resourceType: 'department', resourceId: { in: depIds.map((x) => x.id) } },
        ],
      };
    } else {
      existingWhere = { resourceType: { in: ['position', 'branch', 'department'] } };
    }
    const existing = await this.db.relationTuple.findMany({
      where: existingWhere,
      select: { id: true, resourceType: true, resourceId: true, relation: true, subjectType: true, subjectId: true, subjectRelation: true },
    });

    return this.applyDiff(
      [...desiredByKey.values()],
      existing.map((e) => ({
        id: e.id,
        key: this.key({
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          relation: e.relation,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          subjectRelation: e.subjectRelation ?? undefined,
        }),
      })),
    );
  }

  // ------------------------------------------------------------
  // Task participant roles (Phase 3 — action capabilities)
  //   task:<id>#creator|executor|co_executor|observer@user  (viewer derives from these)
  // ------------------------------------------------------------

  /**
   * Re-sync one task's role tuples from the domain (call after create / participant change).
   * Diff-based like resyncOrderRoles — NOT revoke-then-grant: no transient 403 window for a
   * concurrent task/chat reader, and a no-change resync bumps ZERO cache epochs (task
   * creation used to flush the whole ACL cache twice).
   */
  async resyncTaskRoles(taskId: string): Promise<void> {
    await this.safe(async () => {
      const task = await this.db.task.findUnique({
        where: { id: taskId },
        select: { creatorId: true, participants: { select: { userId: true, role: true } } },
      });
      if (!task) return;
      const desired: RelationTupleInput[] = [
        { resourceType: 'task', resourceId: taskId, relation: 'creator', subjectType: 'user', subjectId: task.creatorId },
      ];
      const seen = new Set<string>();
      for (const p of task.participants) {
        const k = `${p.role}:${p.userId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        desired.push({ resourceType: 'task', resourceId: taskId, relation: p.role, subjectType: 'user', subjectId: p.userId });
      }
      const existing = await this.db.relationTuple.findMany({
        where: { resourceType: 'task', resourceId: taskId, subjectType: 'user' },
        select: { id: true, resourceId: true, relation: true, subjectId: true },
      });
      await this.applyDiff(
        desired,
        existing.map((e) => ({
          id: e.id,
          key: this.key({ resourceType: 'task', resourceId: e.resourceId, relation: e.relation, subjectType: 'user', subjectId: e.subjectId }),
        })),
      );
    });
  }

  async taskDeleted(taskId: string): Promise<void> {
    await this.safe(() => this.access.revokeResource('task', taskId));
  }

  // ------------------------------------------------------------
  // Shop order roles (Phase 3 — order context chat + card actions)
  //   order:<id>#buyer|seller|contributor@user  (viewer derives from these)
  // ------------------------------------------------------------

  /**
   * Re-sync one order's role tuples (call after place / contribute / withdraw / confirm).
   * Diff-based (add missing, remove extra) — NOT revoke-then-grant — so a concurrent reader
   * never sees a transient window with no access (the order chat / rich-card render race).
   */
  async resyncOrderRoles(orderId: string): Promise<void> {
    await this.safe(async () => {
      const order = await this.db.order.findUnique({
        where: { id: orderId },
        select: {
          buyerId: true,
          sellerId: true,
          contributions: { select: { contributorId: true } },
        },
      });
      if (!order) return;
      const desired: RelationTupleInput[] = [
        { resourceType: 'order', resourceId: orderId, relation: 'buyer', subjectType: 'user', subjectId: order.buyerId },
        { resourceType: 'order', resourceId: orderId, relation: 'seller', subjectType: 'user', subjectId: order.sellerId },
      ];
      const seen = new Set<string>();
      for (const c of order.contributions) {
        if (seen.has(c.contributorId)) continue;
        seen.add(c.contributorId);
        desired.push({ resourceType: 'order', resourceId: orderId, relation: 'contributor', subjectType: 'user', subjectId: c.contributorId });
      }
      const existing = await this.db.relationTuple.findMany({
        where: { resourceType: 'order', resourceId: orderId, subjectType: 'user' },
        select: { id: true, resourceId: true, relation: true, subjectId: true },
      });
      await this.applyDiff(
        desired,
        existing.map((e) => ({
          id: e.id,
          key: this.key({ resourceType: 'order', resourceId: e.resourceId, relation: e.relation, subjectType: 'user', subjectId: e.subjectId }),
        })),
      );
    });
  }

  async orderDeleted(orderId: string): Promise<void> {
    await this.safe(() => this.access.revokeResource('order', orderId));
  }

  // ------------------------------------------------------------
  // Calendar event roles (Phase 3 — event context chat)
  //   event:<id>#organizer|attendee@user  (viewer derives from these)
  // ------------------------------------------------------------

  /**
   * Re-sync one event's role tuples (call after create / participant change). Diff-based
   * (no revoke-then-grant window) so a concurrent event-chat reader never transiently 403s.
   */
  async resyncEventRoles(eventId: string): Promise<void> {
    await this.safe(async () => {
      const event = await this.db.calendarEvent.findUnique({
        where: { id: eventId },
        select: { userId: true, participants: { select: { userId: true } } },
      });
      if (!event) return;
      const desired: RelationTupleInput[] = [
        { resourceType: 'event', resourceId: eventId, relation: 'organizer', subjectType: 'user', subjectId: event.userId },
      ];
      const seen = new Set<string>([event.userId]);
      for (const p of event.participants) {
        if (seen.has(p.userId)) continue;
        seen.add(p.userId);
        desired.push({ resourceType: 'event', resourceId: eventId, relation: 'attendee', subjectType: 'user', subjectId: p.userId });
      }
      const existing = await this.db.relationTuple.findMany({
        where: { resourceType: 'event', resourceId: eventId, subjectType: 'user' },
        select: { id: true, resourceId: true, relation: true, subjectId: true },
      });
      await this.applyDiff(
        desired,
        existing.map((e) => ({
          id: e.id,
          key: this.key({ resourceType: 'event', resourceId: e.resourceId, relation: e.relation, subjectType: 'user', subjectId: e.subjectId }),
        })),
      );
    });
  }

  async eventDeleted(eventId: string): Promise<void> {
    await this.safe(() => this.access.revokeResource('event', eventId));
  }

  // ------------------------------------------------------------
  // Office room roles (Виртуальный офис — чат встречи + rich card)
  // ------------------------------------------------------------

  /** Причастные к встрече (OfficeRoomParticipant: host/participant) → tuples office_room. */
  async resyncOfficeRoomRoles(roomId: string): Promise<void> {
    await this.safe(async () => {
      const room = await this.db.officeRoom.findUnique({
        where: { id: roomId },
        select: { participants: { select: { userId: true, role: true } } },
      });
      if (!room) return;
      const desired: RelationTupleInput[] = [];
      const seen = new Set<string>();
      for (const p of room.participants) {
        if (seen.has(p.userId)) continue;
        seen.add(p.userId);
        desired.push({
          resourceType: 'office_room',
          resourceId: roomId,
          relation: p.role === 'host' ? 'host' : 'participant',
          subjectType: 'user',
          subjectId: p.userId,
        });
      }
      const existing = await this.db.relationTuple.findMany({
        where: { resourceType: 'office_room', resourceId: roomId, subjectType: 'user' },
        select: { id: true, resourceId: true, relation: true, subjectId: true },
      });
      await this.applyDiff(
        desired,
        existing.map((e) => ({
          id: e.id,
          key: this.key({ resourceType: 'office_room', resourceId: e.resourceId, relation: e.relation, subjectType: 'user', subjectId: e.subjectId }),
        })),
      );
    });
  }

  async officeRoomDeleted(roomId: string): Promise<void> {
    await this.safe(() => this.access.revokeResource('office_room', roomId));
  }

  /**
   * Additive backfill: tasks' creator + participant roles → tuples.
   * `since` — инкрементальный режим ночного крона (только задачи, изменённые за окно);
   * без since — полный бэкфилл (scripts/backfill-access.cjs). Keyset-батчи: раньше
   * ежедневный крон материализовал ВСЕ задачи платформы в память одним findMany.
   */
  async backfillTasks(since?: Date): Promise<{ added: number }> {
    const BATCH = 500;
    let added = 0;
    let cursor: string | undefined;
    for (;;) {
      const tasks = await this.db.task.findMany({
        ...(since ? { where: { updatedAt: { gte: since } } } : {}),
        select: { id: true, creatorId: true, participants: { select: { userId: true, role: true } } },
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: BATCH,
      });
      if (!tasks.length) break;
      cursor = tasks[tasks.length - 1].id;
      const tuples: RelationTupleInput[] = [];
      for (const t of tasks) {
        tuples.push({ resourceType: 'task', resourceId: t.id, relation: 'creator', subjectType: 'user', subjectId: t.creatorId });
        for (const p of t.participants) {
          tuples.push({ resourceType: 'task', resourceId: t.id, relation: p.role, subjectType: 'user', subjectId: p.userId });
        }
      }
      await this.access.grantMany(tuples);
      added += tuples.length;
      if (tasks.length < BATCH) break;
    }
    return { added };
  }

  // ------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------

  /** Diff desired tuples against existing (keyed) rows; add missing, remove extra. */
  private async applyDiff(desired: RelationTupleInput[], existing: Array<{ id: string; key: string }>): Promise<DiffResult> {
    const desiredByKey = new Map<string, RelationTupleInput>();
    for (const t of desired) desiredByKey.set(this.key(t), t);
    const existingByKey = new Map<string, string>();
    for (const e of existing) existingByKey.set(e.key, e.id);

    const toAdd: RelationTupleInput[] = [];
    for (const [k, t] of desiredByKey) if (!existingByKey.has(k)) toAdd.push(t);
    const toRemoveIds: string[] = [];
    for (const [k, id] of existingByKey) if (!desiredByKey.has(k)) toRemoveIds.push(id);

    if (toAdd.length) await this.access.grantMany(toAdd);
    if (toRemoveIds.length) await this.access.revokeByIds(toRemoveIds);
    return { added: toAdd.length, removed: toRemoveIds.length, total: desiredByKey.size };
  }

  private key(t: RelationTupleInput): string {
    return `${t.resourceType}:${t.resourceId}#${t.relation}@${t.subjectType}:${t.subjectId}#${t.subjectRelation ?? ''}`;
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`access projection failed (non-fatal): ${String((e as Error)?.message ?? e)}`);
    }
  }
}
