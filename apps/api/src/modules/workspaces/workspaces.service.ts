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
import {
  WORKSPACE_LIMITS,
  resolveWorkspaceCardVisibility,
  type WorkspaceCardVisibility,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';

type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'staff' | 'guest';

// Higher rank = more authority. Used to pick a user's effective role and to gate actions.
const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  staff: 2,
  guest: 1,
};

const WS_CONTEXT = 'workspace';

type UserNameRow = { firstName: string; lastName: string | null };

/**
 * WorkspacesService — B2B organizations + membership.
 *
 * Invariants:
 *   - A Workspace is always a business/org (B2B tenant). Personal life is the social
 *     graph (workspaceId = null), handled elsewhere.
 *   - Role/permissions are the single source of truth in UserRole
 *     (context="workspace", tenantId=workspaceId), managed via RolesService.
 *     WorkspaceMember holds only HR metadata (department/position).
 *   - Exactly one workspace role per user per workspace (enforced by setSoleWorkspaceRole).
 *   - One owner per workspace (Workspace.ownerId); ownership changes only via transfer.
 *   - Membership is independent of the personal social graph (hiring ≠ friendship).
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private db: DatabaseService,
    private roles: RolesService,
    private events: EventBusService,
  ) {}

  // ============================================================
  // Workspace CRUD
  // ============================================================

  async createWorkspace(userId: string, data: { name: string; logo?: string }) {
    const owned = await this.db.workspace.count({
      where: { ownerId: userId, isActive: true },
    });
    if (owned >= WORKSPACE_LIMITS.maxWorkspacesOwnedPerUser) {
      throw new BadRequestException(
        `Лимит организаций: ${WORKSPACE_LIMITS.maxWorkspacesOwnedPerUser}`,
      );
    }

    const ws = await this.db.$transaction(async (tx) => {
      const w = await tx.workspace.create({
        data: { name: data.name, logo: data.logo ?? null, ownerId: userId },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: w.id, userId },
      });
      // Owner role (single source of truth) is written in the SAME tx, so a partial
      // failure can never leave the creator locked out of their own workspace.
      await tx.userRole.create({
        data: {
          userId,
          role: 'owner',
          context: WS_CONTEXT,
          tenantId: w.id,
          grantedBy: userId,
        },
      });
      return w;
    });

    // The role row was written directly in the tx (bypassing RolesService), so its
    // cache wasn't busted — do it now, after commit.
    await this.roles.invalidateUserCache(userId);

    return this.serializeWorkspace(ws, 1, 'owner');
  }

  async listMyWorkspaces(userId: string) {
    const allRoles = await this.roles.getUserRoles(userId);
    const wsRoles = allRoles.filter(
      (r) => r.context === WS_CONTEXT && r.tenantId,
    );
    if (wsRoles.length === 0) return [];

    // Highest role per workspace.
    const roleByWs = new Map<string, WorkspaceRole>();
    for (const r of wsRoles) {
      const role = r.role as WorkspaceRole;
      const cur = roleByWs.get(r.tenantId as string);
      if (!cur || ROLE_RANK[role] > ROLE_RANK[cur]) {
        roleByWs.set(r.tenantId as string, role);
      }
    }

    const workspaces = await this.db.workspace.findMany({
      where: { id: { in: [...roleByWs.keys()] }, isActive: true },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return workspaces.map((w) =>
      this.serializeWorkspace(w, w._count.members, roleByWs.get(w.id)),
    );
  }

  async getWorkspace(userId: string, workspaceId: string) {
    const myRole = await this.assertMember(userId, workspaceId);
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      include: { _count: { select: { members: true, tasks: true } } },
    });
    if (!ws) throw new NotFoundException('Организация не найдена');
    return this.serializeWorkspace(ws, ws._count.members, myRole, ws._count.tasks);
  }

  async updateWorkspace(
    userId: string,
    workspaceId: string,
    data: {
      name?: string;
      logo?: string | null;
      description?: string | null;
      industry?: string | null;
      city?: string | null;
      website?: string | null;
      contactEmail?: string | null;
      contactPhone?: string | null;
      cardVisibility?: Partial<WorkspaceCardVisibility>;
    },
  ) {
    const role = await this.assertCanManage(userId, workspaceId);
    const ws = await this.db.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.logo !== undefined ? { logo: data.logo } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.industry !== undefined ? { industry: data.industry } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.website !== undefined ? { website: data.website } : {}),
        ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail } : {}),
        ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone } : {}),
        // Store the FULL resolved visibility map (merged over defaults) for predictable reads.
        ...(data.cardVisibility !== undefined
          ? {
              cardVisibility: resolveWorkspaceCardVisibility(
                data.cardVisibility,
              ) as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
      include: { _count: { select: { members: true, tasks: true } } },
    });
    return this.serializeWorkspace(ws, ws._count.members, role, ws._count.tasks);
  }

  /** Soft-deactivate (owner only). Hard delete + grace period is deferred. */
  async deactivateWorkspace(userId: string, workspaceId: string) {
    await this.assertOwner(userId, workspaceId);
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { isActive: false },
    });
  }

  async transferOwnership(
    userId: string,
    workspaceId: string,
    toUserId: string,
  ) {
    await this.assertOwner(userId, workspaceId);
    if (toUserId === userId) {
      throw new BadRequestException('Вы уже владелец');
    }
    const targetRole = await this.getMyRole(toUserId, workspaceId);
    if (!targetRole) {
      throw new BadRequestException('Новый владелец должен быть участником организации');
    }

    await this.db.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { ownerId: toUserId },
      });
      // New owner → owner; previous owner → admin (single role each) — all atomic,
      // so ownership can't split (two owners / zero owners) on a partial failure.
      await this.setSoleWorkspaceRoleTx(tx, toUserId, workspaceId, 'owner', userId);
      await this.setSoleWorkspaceRoleTx(tx, userId, workspaceId, 'admin', userId);
    });

    // Both users' role rows changed inside the tx → bust both caches now.
    await this.roles.invalidateUserCache(toUserId);
    await this.roles.invalidateUserCache(userId);
  }

  // ============================================================
  // Members
  // ============================================================

  async listMembers(userId: string, workspaceId: string) {
    await this.assertMember(userId, workspaceId);

    const [members, roleRows] = await Promise.all([
      this.db.workspaceMember.findMany({
        where: { workspaceId },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
        orderBy: { joinedAt: 'asc' },
      }),
      this.db.userRole.findMany({
        where: { context: WS_CONTEXT, tenantId: workspaceId, isActive: true },
        select: { userId: true, role: true },
      }),
    ]);

    // Highest role per user (defensive — normally one role each).
    const roleByUser = new Map<string, WorkspaceRole>();
    for (const r of roleRows) {
      const role = r.role as WorkspaceRole;
      const cur = roleByUser.get(r.userId);
      if (!cur || ROLE_RANK[role] > ROLE_RANK[cur]) roleByUser.set(r.userId, role);
    }

    return members.map((m) => ({
      id: m.id,
      workspaceId,
      userId: m.userId,
      userName: this.fullName(m.user),
      userAvatar: m.user.avatar,
      role: roleByUser.get(m.userId) ?? 'staff',
      department: m.department,
      position: m.position,
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  async updateMember(
    userId: string,
    workspaceId: string,
    targetUserId: string,
    data: { role?: WorkspaceRole; position?: string | null; department?: string | null },
  ) {
    await this.assertCanManage(userId, workspaceId);
    const ws = await this.getWorkspaceOrThrow(workspaceId);

    if (targetUserId === ws.ownerId) {
      throw new BadRequestException('Нельзя изменить роль владельца (используйте передачу прав)');
    }
    const targetRole = await this.getMyRole(targetUserId, workspaceId);
    if (!targetRole) throw new NotFoundException('Этот человек не в организации');

    // HR metadata.
    if (data.position !== undefined || data.department !== undefined) {
      await this.db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: {
          ...(data.position !== undefined ? { position: data.position } : {}),
          ...(data.department !== undefined ? { department: data.department } : {}),
        },
      });
    }

    // Role change (single source of truth = UserRole).
    if (data.role && data.role !== targetRole) {
      await this.setSoleWorkspaceRole(targetUserId, workspaceId, data.role, userId);
      this.events.emit(
        'workspace.role.changed',
        { workspaceId, workspaceName: ws.name, userId: targetUserId, role: data.role },
        'WorkspacesService',
      );
    }
  }

  /** Fire a member (owner/admin). Owner cannot be removed — transfer first. */
  async removeMember(userId: string, workspaceId: string, targetUserId: string) {
    await this.assertCanManage(userId, workspaceId);
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    if (targetUserId === ws.ownerId) {
      throw new BadRequestException('Нельзя удалить владельца организации');
    }
    const targetRole = await this.getMyRole(targetUserId, workspaceId);
    if (!targetRole) throw new NotFoundException('Этот человек не в организации');

    await this.revokeAllWorkspaceRoles(targetUserId, workspaceId);
    await this.db.workspaceMember.deleteMany({
      where: { workspaceId, userId: targetUserId },
    });

    this.events.emit(
      'workspace.member.removed',
      { workspaceId, workspaceName: ws.name, userId: targetUserId },
      'WorkspacesService',
    );
  }

  /** Voluntary leave (non-owner). */
  async leaveWorkspace(userId: string, workspaceId: string) {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const myRole = await this.getMyRole(userId, workspaceId);
    if (!myRole) throw new NotFoundException('Вы не состоите в этой организации');
    if (userId === ws.ownerId) {
      throw new BadRequestException('Владелец не может выйти — сначала передайте права');
    }
    await this.revokeAllWorkspaceRoles(userId, workspaceId);
    await this.db.workspaceMember.deleteMany({ where: { workspaceId, userId } });
  }

  // ============================================================
  // Invitations
  // ============================================================

  async inviteMember(
    userId: string,
    workspaceId: string,
    data: {
      phone: string;
      role: WorkspaceRole;
      position?: string;
      department?: string;
      message?: string;
    },
  ) {
    await this.assertCanManage(userId, workspaceId);
    const ws = await this.getWorkspaceOrThrow(workspaceId);

    const target = await this.db.user.findUnique({
      where: { phone: data.phone },
      select: { id: true, deletedAt: true },
    });
    if (target && target.id === userId) {
      throw new BadRequestException('Нельзя пригласить самого себя');
    }
    if (target) {
      const existing = await this.db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: target.id } },
        select: { id: true },
      });
      if (existing) throw new ConflictException('Этот человек уже в организации');
    }

    const pending = await this.db.workspaceInvitation.findFirst({
      where: { workspaceId, toPhone: data.phone, status: 'pending' },
      select: { id: true },
    });
    if (pending) throw new ConflictException('Приглашение на этот номер уже отправлено');

    const pendingCount = await this.db.workspaceInvitation.count({
      where: { workspaceId, status: 'pending' },
    });
    if (pendingCount >= WORKSPACE_LIMITS.maxPendingInvitationsPerWorkspace) {
      throw new BadRequestException('Достигнут лимит приглашений');
    }

    const expiresAt = new Date(
      Date.now() + WORKSPACE_LIMITS.invitationTtlDays * 24 * 60 * 60 * 1000,
    );
    const inv = await this.db.workspaceInvitation.create({
      data: {
        workspaceId,
        invitedBy: userId,
        toUserId: target?.id ?? null,
        toPhone: data.phone,
        role: data.role,
        position: data.position ?? null,
        department: data.department ?? null,
        message: data.message ?? null,
        expiresAt,
      },
    });

    this.events.emit(
      'workspace.invitation.sent',
      {
        invitationId: inv.id,
        workspaceId,
        workspaceName: ws.name,
        toUserId: inv.toUserId,
        role: inv.role,
        position: inv.position,
        message: inv.message,
      },
      'WorkspacesService',
    );

    const inviter = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return this.serializeInvitation(inv, ws, inviter);
  }

  async listOutgoingInvitations(userId: string, workspaceId: string) {
    await this.assertCanManage(userId, workspaceId);
    const invs = await this.db.workspaceInvitation.findMany({
      where: { workspaceId, status: 'pending' },
      include: {
        workspace: { select: { name: true, logo: true } },
        inviter: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return invs.map((i) => this.serializeInvitation(i, i.workspace, i.inviter));
  }

  async cancelInvitation(userId: string, workspaceId: string, invitationId: string) {
    await this.assertCanManage(userId, workspaceId);
    const inv = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!inv || inv.workspaceId !== workspaceId) {
      throw new NotFoundException('Приглашение не найдено');
    }
    if (inv.status !== 'pending') {
      throw new BadRequestException('Приглашение уже обработано');
    }
    await this.db.workspaceInvitation.update({
      where: { id: invitationId },
      data: { status: 'cancelled', respondedAt: new Date() },
    });
  }

  /** Incoming pending invitations for the current user (dashboard cards). */
  async listIncomingInvitations(userId: string) {
    const invs = await this.db.workspaceInvitation.findMany({
      where: { toUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
      include: {
        workspace: { select: { name: true, logo: true } },
        inviter: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return invs.map((i) => this.serializeInvitation(i, i.workspace, i.inviter));
  }

  async acceptInvitation(userId: string, invitationId: string) {
    const inv = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
      include: { workspace: { select: { id: true, name: true, isActive: true } } },
    });
    if (!inv || inv.toUserId !== userId) {
      throw new NotFoundException('Приглашение не найдено');
    }
    if (inv.status !== 'pending') {
      throw new BadRequestException('Приглашение уже обработано');
    }
    if (inv.expiresAt <= new Date()) {
      throw new BadRequestException('Срок приглашения истёк');
    }
    if (!inv.workspace.isActive) {
      throw new BadRequestException('Организация неактивна');
    }

    // All writes in one transaction. The status flip is the atomic guard against a
    // double-accept race (and accept-after-cancel): only the first concurrent call
    // that flips pending→accepted proceeds; the rest see count 0 and bail (rollback).
    await this.db.$transaction(async (tx) => {
      const flipped = await tx.workspaceInvitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      if (flipped.count === 0) {
        throw new BadRequestException('Приглашение уже обработано');
      }

      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } },
        create: {
          workspaceId: inv.workspaceId,
          userId,
          position: inv.position,
          department: inv.department,
        },
        update: { position: inv.position, department: inv.department },
      });

      await this.setSoleWorkspaceRoleTx(
        tx,
        userId,
        inv.workspaceId,
        inv.role as WorkspaceRole,
        inv.invitedBy,
      );
    });

    // Role rows changed inside the tx → bust this user's cache now.
    await this.roles.invalidateUserCache(userId);

    const me = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    this.events.emit(
      'workspace.invitation.accepted',
      {
        workspaceId: inv.workspaceId,
        workspaceName: inv.workspace.name,
        inviterId: inv.invitedBy,
        byName: me ? this.fullName(me) : '',
      },
      'WorkspacesService',
    );

    const ws = await this.db.workspace.findUnique({
      where: { id: inv.workspaceId },
      include: { _count: { select: { members: true } } },
    });
    return ws
      ? this.serializeWorkspace(ws, ws._count.members, inv.role as WorkspaceRole)
      : null;
  }

  async rejectInvitation(userId: string, invitationId: string) {
    const inv = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
      include: { workspace: { select: { name: true } } },
    });
    if (!inv || inv.toUserId !== userId) {
      throw new NotFoundException('Приглашение не найдено');
    }
    if (inv.status !== 'pending') {
      throw new BadRequestException('Приглашение уже обработано');
    }
    await this.db.workspaceInvitation.update({
      where: { id: invitationId },
      data: { status: 'rejected', respondedAt: new Date() },
    });

    const me = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    this.events.emit(
      'workspace.invitation.rejected',
      {
        workspaceId: inv.workspaceId,
        workspaceName: inv.workspace.name,
        inviterId: inv.invitedBy,
        byName: me ? this.fullName(me) : '',
      },
      'WorkspacesService',
    );
  }

  /**
   * Called from AuthService.register: external workspace invitations (toUserId=null)
   * that targeted this phone are bound to the new user and surfaced as notifications.
   */
  async activatePendingWorkspaceInvitationsForNewUser(userId: string, phone: string) {
    const pending = await this.db.workspaceInvitation.findMany({
      where: { toUserId: null, toPhone: phone, status: 'pending' },
      include: { workspace: { select: { name: true } } },
    });
    if (pending.length === 0) return;

    await this.db.workspaceInvitation.updateMany({
      where: { toUserId: null, toPhone: phone, status: 'pending' },
      data: { toUserId: userId },
    });

    for (const inv of pending) {
      this.events.emit(
        'workspace.invitation.sent',
        {
          invitationId: inv.id,
          workspaceId: inv.workspaceId,
          workspaceName: inv.workspace.name,
          toUserId: userId,
          role: inv.role,
          position: inv.position,
          message: inv.message,
        },
        'WorkspacesService',
      );
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private fullName(u: UserNameRow): string {
    return u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName;
  }

  private async getWorkspaceOrThrow(workspaceId: string) {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException('Организация не найдена');
    return ws;
  }

  /** The user's effective (highest) role in the workspace, or null if not a member. */
  private async getMyRole(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
  }

  private async assertMember(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceRole> {
    const role = await this.getMyRole(userId, workspaceId);
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    return role;
  }

  private async assertCanManage(userId: string, workspaceId: string) {
    const role = await this.assertMember(userId, workspaceId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Недостаточно прав');
    }
    return role;
  }

  private async assertOwner(userId: string, workspaceId: string) {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    if (ws.ownerId !== userId) {
      throw new ForbiddenException('Только владелец может выполнить это действие');
    }
    return ws;
  }

  /** Ensure the user has exactly ONE workspace role (revoke others, assign target). */
  private async setSoleWorkspaceRole(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
    grantedBy: string,
  ) {
    const current = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    for (const r of current) {
      if (r.role !== role) {
        await this.roles.revokeRole(userId, r.role, WS_CONTEXT, workspaceId);
      }
    }
    await this.roles.assignRole(userId, role, WS_CONTEXT, workspaceId, grantedBy);
  }

  /**
   * Transactional variant of setSoleWorkspaceRole: within the given tx, deactivate the
   * user's other active workspace roles and upsert the target role. Does NOT bust the
   * roles cache — the caller MUST call roles.invalidateUserCache(userId) after the tx
   * commits. Used by the atomic create/accept/transfer paths.
   */
  private async setSoleWorkspaceRoleTx(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
    grantedBy: string,
  ) {
    await tx.userRole.updateMany({
      where: {
        userId,
        context: WS_CONTEXT,
        tenantId: workspaceId,
        role: { not: role },
        isActive: true,
      },
      data: { isActive: false },
    });
    await tx.userRole.upsert({
      where: {
        userId_role_context_tenantId: {
          userId,
          role,
          context: WS_CONTEXT,
          tenantId: workspaceId,
        },
      },
      create: { userId, role, context: WS_CONTEXT, tenantId: workspaceId, grantedBy },
      update: { isActive: true, grantedBy },
    });
  }

  private async revokeAllWorkspaceRoles(userId: string, workspaceId: string) {
    const current = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    for (const r of current) {
      await this.roles.revokeRole(userId, r.role, WS_CONTEXT, workspaceId);
    }
  }

  private serializeWorkspace(
    ws: {
      id: string;
      name: string;
      logo: string | null;
      description: string | null;
      industry: string | null;
      city: string | null;
      website: string | null;
      contactEmail: string | null;
      contactPhone: string | null;
      cardVisibility: Prisma.JsonValue | null;
      ownerId: string;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
    membersCount: number,
    myRole?: WorkspaceRole,
    tasksCount?: number,
  ) {
    // owner/admin see everything (for editing); other members see only the fields
    // the org's card visibility marks visible. name/logo are always visible.
    const canSeeAll = myRole === 'owner' || myRole === 'admin';
    const vis = resolveWorkspaceCardVisibility(
      ws.cardVisibility as Partial<WorkspaceCardVisibility> | null,
    );
    const show = (
      field:
        | 'description'
        | 'industry'
        | 'city'
        | 'website'
        | 'contactEmail'
        | 'contactPhone',
      value: string | null,
    ) => (canSeeAll || vis[field] ? value : null);

    return {
      id: ws.id,
      name: ws.name,
      logo: ws.logo,
      description: show('description', ws.description),
      industry: show('industry', ws.industry),
      city: show('city', ws.city),
      website: show('website', ws.website),
      contactEmail: show('contactEmail', ws.contactEmail),
      contactPhone: show('contactPhone', ws.contactPhone),
      // Only managers get the editable visibility map.
      ...(canSeeAll ? { cardVisibility: vis } : {}),
      ownerId: ws.ownerId,
      membersCount,
      ...(tasksCount !== undefined ? { tasksCount } : {}),
      isActive: ws.isActive,
      ...(myRole ? { myRole } : {}),
      createdAt: ws.createdAt.toISOString(),
      updatedAt: ws.updatedAt.toISOString(),
    };
  }

  private serializeInvitation(
    inv: {
      id: string;
      workspaceId: string;
      invitedBy: string;
      toUserId: string | null;
      toPhone: string;
      role: string;
      position: string | null;
      department: string | null;
      message: string | null;
      status: string;
      expiresAt: Date;
      createdAt: Date;
    },
    workspace: { name: string; logo?: string | null } | null,
    inviter: UserNameRow | null,
  ) {
    return {
      id: inv.id,
      workspaceId: inv.workspaceId,
      workspaceName: workspace?.name ?? '',
      workspaceLogo: workspace?.logo ?? null,
      invitedBy: inv.invitedBy,
      invitedByName: inviter ? this.fullName(inviter) : '',
      toUserId: inv.toUserId,
      toPhone: inv.toPhone,
      role: inv.role as WorkspaceRole,
      position: inv.position,
      department: inv.department,
      message: inv.message,
      status: inv.status as
        | 'pending'
        | 'accepted'
        | 'rejected'
        | 'cancelled'
        | 'expired',
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
    };
  }
}
