import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { AccessService } from './access.service';
import { RelationTupleInput } from './access.types';

// Workspace access roles that map to a `workspace` relation in ACCESS_SCHEMA.
// Other UserRole values (shop/showcase staff, system roles) are projected later phases.
const WS_ROLES = ['owner', 'admin', 'manager', 'member'];

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
        where: { userId, context: 'workspace', isActive: true, tenantId: { not: null }, role: { in: WS_ROLES } },
        select: { tenantId: true, role: true },
      });
      const desired: RelationTupleInput[] = [];
      for (const r of roles) {
        if (!r.tenantId) continue;
        desired.push({ resourceType: 'workspace', resourceId: r.tenantId, relation: r.role, subjectType: 'user', subjectId: userId });
      }
      const existing = await this.db.relationTuple.findMany({
        where: { subjectType: 'user', subjectId: userId, resourceType: 'workspace', relation: { in: WS_ROLES } },
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

  async reconcile(): Promise<{ circle: DiffResult; workspace: DiffResult; circleCalendar: DiffResult }> {
    return {
      circle: await this.reconcileCircles(),
      workspace: await this.reconcileWorkspaceRoles(),
      circleCalendar: await this.reconcileCircleCalendar(),
    };
  }

  /**
   * Additive backfill of shop access edges into tuples: shop ownership + showcase→shop parent
   * pointers (shares & staff are tuple-native — written directly by ShopService, not backfilled).
   * ADDITIVE only (never deletes); deletions handled by live revokes (delete showcase / unshare).
   */
  async backfillShops(): Promise<{ added: number }> {
    const tuples: RelationTupleInput[] = [];

    const shops = await this.db.shop.findMany({ select: { id: true, ownerType: true, ownerId: true } });
    for (const s of shops) {
      if (s.ownerType === 'user') {
        tuples.push({ resourceType: 'shop', resourceId: s.id, relation: 'owner', subjectType: 'user', subjectId: s.ownerId });
      } else {
        // workspace-owned: the workspace admins (⊇ owner) manage the shop
        tuples.push({ resourceType: 'shop', resourceId: s.id, relation: 'manager', subjectType: 'workspace', subjectId: s.ownerId, subjectRelation: 'admin' });
      }
    }

    const showcases = await this.db.showcase.findMany({ select: { id: true, shopId: true } });
    for (const sc of showcases) {
      tuples.push({ resourceType: 'showcase', resourceId: sc.id, relation: 'parent', subjectType: 'shop', subjectId: sc.shopId });
    }

    // Legacy ShowcaseShare + UserRole(shop/showcase) staff are dropped — shares & staff are
    // tuple-native now (written directly by ShopService). Only ownership + parent are projected.
    await this.access.grantMany(tuples);
    return { added: tuples.length };
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
    const tuples: RelationTupleInput[] = [];

    // Legacy CalendarShare is dropped — personal calendar shares are tuple-native now (CalendarService).
    const circles = await this.db.circle.findMany({
      where: { calendarVisibility: { in: ['busy', 'detailed'] } },
      select: { id: true, ownerId: true, calendarVisibility: true },
    });
    for (const c of circles) {
      tuples.push({
        resourceType: 'calendar',
        resourceId: c.ownerId,
        relation: c.calendarVisibility === 'detailed' ? 'detailed_viewer' : 'busy_viewer',
        subjectType: 'circle',
        subjectId: c.id,
        subjectRelation: 'member',
      });
    }

    await this.access.grantMany(tuples);
    return { added: tuples.length };
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
      where: { context: 'workspace', isActive: true, tenantId: { not: null }, role: { in: WS_ROLES } },
      select: { tenantId: true, role: true, userId: true },
    });
    const desired: RelationTupleInput[] = [];
    for (const r of roles) {
      if (!r.tenantId) continue;
      desired.push({ resourceType: 'workspace', resourceId: r.tenantId, relation: r.role, subjectType: 'user', subjectId: r.userId });
    }
    const existing = await this.db.relationTuple.findMany({
      where: { resourceType: 'workspace', relation: { in: WS_ROLES }, subjectType: 'user' },
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
  // Task participant roles (Phase 3 — action capabilities)
  //   task:<id>#creator|executor|co_executor|observer@user  (viewer derives from these)
  // ------------------------------------------------------------

  /** Re-sync one task's role tuples from the domain (call after create / participant change). */
  async resyncTaskRoles(taskId: string): Promise<void> {
    await this.safe(async () => {
      const task = await this.db.task.findUnique({
        where: { id: taskId },
        select: { creatorId: true, participants: { select: { userId: true, role: true } } },
      });
      if (!task) return;
      await this.access.revokeResource('task', taskId);
      const tuples: RelationTupleInput[] = [
        { resourceType: 'task', resourceId: taskId, relation: 'creator', subjectType: 'user', subjectId: task.creatorId },
      ];
      for (const p of task.participants) {
        tuples.push({ resourceType: 'task', resourceId: taskId, relation: p.role, subjectType: 'user', subjectId: p.userId });
      }
      await this.access.grantMany(tuples);
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

  /** Additive backfill: existing tasks' creator + participant roles → tuples. */
  async backfillTasks(): Promise<{ added: number }> {
    const tasks = await this.db.task.findMany({
      select: { id: true, creatorId: true, participants: { select: { userId: true, role: true } } },
    });
    const tuples: RelationTupleInput[] = [];
    for (const t of tasks) {
      tuples.push({ resourceType: 'task', resourceId: t.id, relation: 'creator', subjectType: 'user', subjectId: t.creatorId });
      for (const p of t.participants) {
        tuples.push({ resourceType: 'task', resourceId: t.id, relation: p.role, subjectType: 'user', subjectId: p.userId });
      }
    }
    await this.access.grantMany(tuples);
    return { added: tuples.length };
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
