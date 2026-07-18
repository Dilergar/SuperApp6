import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DI_TOKENS } from '../../shared/di-tokens';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import {
  CONTACT_LIMITS,
  TEAM_WORKSPACE_ROLES,
  resolveCardVisibility,
  mergeVisibilities,
  maskLastName,
  type CardVisibility,
  type Contact,
  type ContactUserCard,
} from '@superapp/shared';
import type { Prisma } from '@prisma/client';

/**
 * ContactsService — the bilateral social-graph core ("Окружение").
 *
 * Model:
 *   - Each side assigns exactly ONE role to the other (asymmetric:
 *     roleAForB = role A gave B, roleBForA = role B gave A). The role is
 *     shown on the card. There is no separate category/label concept.
 *   - Card visibility is configured PER GROUP (Circle) by the owner.
 *     When a viewer is in several of the owner's groups → UNION of those
 *     groups' visibility; in none → the owner's default
 *     (users.card_visibility).
 *
 * Rules encoded here (not in Prisma):
 *   - Canonical ordering userA < userB.
 *   - Throttle / cooldown / max-pending from CONTACT_LIMITS.
 */
@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private redis: RedisService,
    private accessProjection: AccessProjectionService,
    private workspaceContext: WorkspaceContextService,
    private moduleRef: ModuleRef,
  ) {}

  /**
   * Синхронный отзыв прямых finbook-грантов между парой при разрыве связи (удаление /
   * блок). Security-обязательный эффект: раньше он ехал ТОЛЬКО по at-most-once шине —
   * потерянное событие навсегда оставляло заблокированному editor-доступ к книге.
   * Шина (FinancesEvents) и ночной свип FinancesCron остаются вторым/третьим ремнём.
   * Ленивый токен: прямой импорт создал бы цикл (FinancesService → ContactsService).
   */
  private async revokeFinbookSharesBetween(a: string, b: string): Promise<void> {
    try {
      const finances = this.moduleRef.get<{
        revokeSharesBetween: (a: string, b: string) => Promise<void>;
      }>(DI_TOKENS.FinancesService, { strict: false });
      await finances.revokeSharesBetween(a, b);
    } catch (err) {
      // Связь уже разорвана — не роняем запрос; error (не warn), чтобы это было видно,
      // а свип FinancesCron гарантированно доберёт отзыв.
      this.logger.error(
        `finbook share revoke failed (sweep will repair): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================================================
  // Contacts — list / read / update / delete
  // ============================================================

  /**
   * Confirmed contacts for a user (me/them view), newest first.
   * Cursor-paginated on (confirmedAt, id) so the hottest list query in the
   * app stays bounded regardless of how large an environment grows.
   */
  async listContacts(
    userId: string,
    cursor?: string,
  ): Promise<{ items: Contact[]; nextCursor: string | null }> {
    const limit = CONTACT_LIMITS.contactsPageSize;
    const decoded = decodeLinkCursor(cursor);

    const where: Prisma.ContactLinkWhereInput = {
      OR: [{ userAId: userId }, { userBId: userId }],
    };
    if (decoded) {
      // Keyset: rows strictly "older" than the cursor (confirmedAt, id).
      where.AND = {
        OR: [
          { confirmedAt: { lt: decoded.confirmedAt } },
          { confirmedAt: decoded.confirmedAt, id: { lt: decoded.id } },
        ],
      };
    }

    const links = await this.db.contactLink.findMany({
      where,
      include: {
        userA: { select: this.userCardSelect() },
        userB: { select: this.userCardSelect() },
        memberships: { select: this.membershipSelect() },
      },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = links.length > limit;
    const page = hasMore ? links.slice(0, limit) : links;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeLinkCursor(last.confirmedAt, last.id) : null;

    return {
      items: page.map((link) => this.mapLinkToContact(link, userId)),
      nextCursor,
    };
  }

  /**
   * Resolve a specific set of the user's links to the me/them view. Used by
   * CirclesService to render one group's members WITHOUT loading the owner's
   * entire environment.
   */
  async listContactsByLinkIds(
    userId: string,
    linkIds: string[],
  ): Promise<Contact[]> {
    if (linkIds.length === 0) return [];
    const links = await this.db.contactLink.findMany({
      where: {
        id: { in: linkIds },
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      include: {
        userA: { select: this.userCardSelect() },
        userB: { select: this.userCardSelect() },
        memberships: { select: this.membershipSelect() },
      },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
    });
    return links.map((link) => this.mapLinkToContact(link, userId));
  }

  async getContact(userId: string, linkId: string): Promise<Contact> {
    const link = await this.db.contactLink.findUnique({
      where: { id: linkId },
      include: {
        userA: { select: this.userCardSelect() },
        userB: { select: this.userCardSelect() },
        memberships: { select: this.membershipSelect() },
      },
    });
    if (!link) throw new NotFoundException('Контакт не найден');
    if (link.userAId !== userId && link.userBId !== userId) {
      throw new ForbiddenException('Нет доступа к этому контакту');
    }
    return this.mapLinkToContact(link, userId);
  }

  /**
   * Role tags for the messenger: for each target user P, the label the VIEWER
   * assigns P (shown next to P's name in a group chat). The label lives on the
   * ContactLink between viewer and P (canonical ordering userA < userB):
   *   - viewer is side A → roleAForB
   *   - viewer is side B → roleBForA
   * One findMany, no N+1; users with no link → null.
   */
  async resolveLabels(
    viewerId: string,
    userIds: string[],
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const targets = [...new Set(userIds)].filter((id) => id && id !== viewerId);
    for (const id of targets) result.set(id, null);
    if (targets.length === 0) return result;

    const links = await this.db.contactLink.findMany({
      where: {
        OR: [
          { userAId: viewerId, userBId: { in: targets } },
          { userBId: viewerId, userAId: { in: targets } },
        ],
      },
      select: {
        userAId: true,
        userBId: true,
        roleAForB: true,
        roleBForA: true,
      },
    });

    for (const link of links) {
      if (link.userAId === viewerId) {
        // viewer is side A → their label for B (the target) is roleAForB
        result.set(link.userBId, link.roleAForB ?? null);
      } else {
        // viewer is side B → their label for A (the target) is roleBForA
        result.set(link.userAId, link.roleBForA ?? null);
      }
    }
    return result;
  }

  /**
   * The user ids of everyone in `userId`'s Окружение (confirmed ContactLinks),
   * i.e. the "other side" of every link. One findMany, no N+1. Used by the
   * messenger presence layer (only contacts may see presence) and fan-out.
   */
  async getContactUserIds(userId: string): Promise<string[]> {
    const links = await this.db.contactLink.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { userAId: true, userBId: true },
    });
    const ids = new Set<string>();
    for (const l of links) ids.add(l.userAId === userId ? l.userBId : l.userAId);
    return [...ids];
  }

  /**
   * THE reachability gate for every "between people" action (assign a task, invite to an
   * event, share a showcase, open a DM). Context-aware:
   *
   *   - PERSONAL context (no active workspace): each id must be a confirmed contact of
   *     `ownerId` AND the pair must not be blocked in EITHER direction.
   *   - WORKSPACE context («рабочий пропуск», X-Workspace-Id verified fail-closed by the
   *     interceptor): coworkers are reachable by CO-MEMBERSHIP in the active workspace —
   *     the personal Окружение is NOT required (Slack/Bitrix24 model). Personal blocks do
   *     not gate work artifacts (tasks/events/work chats); direct messages still respect
   *     them — the messenger passes `alwaysCheckBlocks` for DM.
   *
   * Batch: 2 queries total for any number of ids.
   */
  async assertReachable(
    ownerId: string,
    ids: string[],
    notLinkedMessage = 'Это действие доступно только для людей из вашего окружения',
    opts: { alwaysCheckBlocks?: boolean } = {},
  ): Promise<void> {
    const others = [...new Set(ids)].filter((id) => id && id !== ownerId);
    if (others.length === 0) return;

    const workspaceId = this.workspaceContext.activeWorkspaceId;
    if (workspaceId) {
      // Со-членство по РОЛЯМ (единый источник UserRole) и только КОМАНДНЫМ
      // (trainee и выше): «Подрядчик» (contractor, Коллаб-модель) изолирован —
      // он не инициирует действия через рабочий пропуск И не достижим через него.
      // Его работа течёт через явные гранты задач/чатов, которые пишет владеющий сервис.
      const teamRows = await this.db.userRole.findMany({
        where: {
          context: 'workspace',
          tenantId: workspaceId,
          isActive: true,
          userId: { in: [ownerId, ...others] },
          role: { in: [...TEAM_WORKSPACE_ROLES] },
        },
        select: { userId: true },
      });
      const teamSet = new Set(teamRows.map((r) => r.userId));
      if (!teamSet.has(ownerId)) {
        throw new ForbiddenException('Подрядчику доступны только его задачи');
      }
      if (others.some((id) => !teamSet.has(id))) {
        throw new ForbiddenException(
          'Это действие доступно только для сотрудников организации',
        );
      }
      if (opts.alwaysCheckBlocks) await this.assertNotBlocked(ownerId, others);
      return;
    }

    const links = await this.db.contactLink.findMany({
      where: {
        OR: others.map((id) => {
          const [a, b] = ownerId < id ? [ownerId, id] : [id, ownerId];
          return { userAId: a, userBId: b };
        }),
      },
      select: { userAId: true, userBId: true },
    });
    const linked = new Set(links.map((l) => (l.userAId === ownerId ? l.userBId : l.userAId)));
    if (others.some((id) => !linked.has(id))) {
      throw new ForbiddenException(notLinkedMessage);
    }

    await this.assertNotBlocked(ownerId, others);
  }

  /** Throws if ANY pair (ownerId, id) is blocked in either direction. */
  private async assertNotBlocked(ownerId: string, others: string[]): Promise<void> {
    const blocked = await this.db.contactBlock.findFirst({
      where: {
        OR: [
          { blockerId: ownerId, blockedId: { in: others } },
          { blockerId: { in: others }, blockedId: ownerId },
        ],
      },
      select: { id: true },
    });
    if (blocked) {
      // Deliberately neutral — never reveal who blocked whom.
      throw new ForbiddenException('Действие недоступно для этого пользователя');
    }
  }

  async updateContact(
    userId: string,
    linkId: string,
    data: { myRole?: string | null },
  ) {
    const link = await this.db.contactLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Контакт не найден');
    const side = this.sideFor(userId, link);
    if (!side) throw new ForbiddenException('Нет доступа к этому контакту');

    const patch: Prisma.ContactLinkUpdateInput = {};
    if (data.myRole !== undefined) {
      // Only the role I gave them (shown on my card for them).
      if (side === 'A') patch.roleAForB = data.myRole;
      else patch.roleBForA = data.myRole;
    }

    const updated = await this.db.contactLink.update({
      where: { id: linkId },
      data: patch,
      include: {
        userA: { select: this.userCardSelect() },
        userB: { select: this.userCardSelect() },
        memberships: { select: this.membershipSelect() },
      },
    });
    return this.mapLinkToContact(updated, userId);
  }

  async deleteContact(userId: string, linkId: string) {
    // Memberships are loaded BEFORE the delete: they cascade away with the
    // link, but their mirrored access tuples must be revoked explicitly.
    const link = await this.db.contactLink.findUnique({
      where: { id: linkId },
      include: { memberships: { select: this.membershipSelect() } },
    });
    if (!link) throw new NotFoundException('Контакт не найден');
    if (link.userAId !== userId && link.userBId !== userId) {
      throw new ForbiddenException('Нет доступа к этому контакту');
    }

    await this.db.contactLink.delete({ where: { id: linkId } });
    await this.revokeMembershipTuples(link);
    await this.revokeFinbookSharesBetween(link.userAId, link.userBId);

    this.events.emit(
      'contact.removed',
      {
        contactLinkId: linkId,
        userIds: [link.userAId, link.userBId],
        removedBy: userId,
      },
      'contacts',
    );

    await Promise.all([
      this.redis.invalidateUserProfile(link.userAId),
      this.redis.invalidateUserProfile(link.userBId),
    ]);
  }

  // ============================================================
  // Invitations
  // ============================================================

  async sendInvitation(
    fromUserId: string,
    data: {
      toPhone: string;
      proposedRoleForRecipient?: string;
      proposedRoleForSender?: string;
      message?: string;
      autoAddToCircleIds?: string[];
    },
  ) {
    const sender = await this.db.user.findUnique({
      where: { id: fromUserId },
      select: { id: true, phone: true, firstName: true, lastName: true },
    });
    if (!sender) throw new NotFoundException('Отправитель не найден');

    if (sender.phone === data.toPhone) {
      throw new BadRequestException('Нельзя пригласить самого себя');
    }

    // Does the recipient already exist?
    const recipient = await this.db.user.findUnique({
      where: { phone: data.toPhone },
      select: { id: true, firstName: true },
    });

    // If recipient exists, check blocks and existing link/invitation.
    if (recipient) {
      const block = await this.db.contactBlock.findFirst({
        where: {
          OR: [
            { blockerId: recipient.id, blockedId: fromUserId },
            { blockerId: fromUserId, blockedId: recipient.id },
          ],
        },
      });
      if (block) {
        throw new ForbiddenException('Невозможно отправить приглашение этому пользователю');
      }

      const [a, b] = canonical(fromUserId, recipient.id);
      const existingLink = await this.db.contactLink.findUnique({
        where: { userAId_userBId: { userAId: a, userBId: b } },
      });
      if (existingLink) {
        throw new ConflictException('Этот пользователь уже в вашем окружении');
      }

      const existingPending = await this.db.contactInvitation.findFirst({
        where: {
          status: 'pending',
          OR: [
            { fromUserId, toUserId: recipient.id },
            { fromUserId: recipient.id, toUserId: fromUserId },
          ],
        },
      });
      if (existingPending) {
        throw new ConflictException('Уже есть активное приглашение между вами');
      }
    } else {
      // External invitation: still check for existing pending to same phone.
      const existingPendingToPhone = await this.db.contactInvitation.findFirst({
        where: {
          fromUserId,
          toPhone: data.toPhone,
          status: 'pending',
        },
      });
      if (existingPendingToPhone) {
        throw new ConflictException('Вы уже приглашали этого пользователя');
      }
    }

    // Cooldown: any invitation (cancelled/rejected/expired) to the same phone within cooldown window?
    const cooldownSince = new Date(
      Date.now() - CONTACT_LIMITS.resendCooldownHours * 60 * 60 * 1000,
    );
    const recentRejected = await this.db.contactInvitation.findFirst({
      where: {
        fromUserId,
        toPhone: data.toPhone,
        status: { in: ['cancelled', 'rejected', 'expired'] },
        updatedAt: { gte: cooldownSince },
      },
    });
    if (recentRejected) {
      throw new BadRequestException(
        `Повторная отправка возможна через ${CONTACT_LIMITS.resendCooldownHours} часов`,
      );
    }

    // Throttle: max invitations per 24h.
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sentIn24h = await this.db.contactInvitation.count({
      where: { fromUserId, createdAt: { gte: since24h } },
    });
    if (sentIn24h >= CONTACT_LIMITS.maxInvitationsPer24h) {
      throw new BadRequestException(
        `Превышен лимит приглашений: ${CONTACT_LIMITS.maxInvitationsPer24h} в 24 часа`,
      );
    }

    // Max pending outgoing.
    const pendingOutgoing = await this.db.contactInvitation.count({
      where: { fromUserId, status: 'pending' },
    });
    if (pendingOutgoing >= CONTACT_LIMITS.maxPendingOutgoingInvitations) {
      throw new BadRequestException(
        `Превышен лимит активных приглашений: ${CONTACT_LIMITS.maxPendingOutgoingInvitations}`,
      );
    }

    const expiresAt = new Date(
      Date.now() + CONTACT_LIMITS.invitationTtlDays * 24 * 60 * 60 * 1000,
    );

    const invitation = await this.db.contactInvitation.create({
      data: {
        fromUserId,
        toUserId: recipient?.id ?? null,
        toPhone: data.toPhone,
        proposedRoleForRecipient: data.proposedRoleForRecipient ?? null,
        proposedRoleForSender: data.proposedRoleForSender ?? null,
        message: data.message ?? null,
        status: 'pending',
        expiresAt,
      },
    });

    this.events.emit(
      'contact.invitation.sent',
      {
        invitationId: invitation.id,
        fromUserId,
        fromName: formatName(sender.firstName, sender.lastName),
        fromPhone: sender.phone,
        toUserId: recipient?.id ?? null,
        toPhone: data.toPhone,
        proposedRoleForRecipient: invitation.proposedRoleForRecipient,
        message: invitation.message,
      },
      'contacts',
    );

    return invitation;
  }

  async acceptInvitation(
    userId: string,
    invitationId: string,
    data: {
      myRole?: string;
      theirRole?: string;
      autoAddToCircleIds?: string[];
    },
  ) {
    const invitation = await this.db.contactInvitation.findUnique({
      where: { id: invitationId },
      include: {
        fromUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!invitation) throw new NotFoundException('Приглашение не найдено');
    if (invitation.toUserId !== userId) {
      throw new ForbiddenException('Это приглашение не для вас');
    }
    if (invitation.status !== 'pending') {
      throw new ConflictException('Приглашение уже обработано');
    }
    if (invitation.expiresAt < new Date()) {
      await this.db.contactInvitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      });
      throw new ConflictException('Приглашение истекло');
    }

    // Block check — either side may have blocked after invitation was sent.
    const block = await this.db.contactBlock.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: invitation.fromUserId },
          { blockerId: invitation.fromUserId, blockedId: userId },
        ],
      },
    });
    if (block) {
      throw new ForbiddenException('Принятие приглашения заблокировано');
    }

    // Resolve roles. Sender's view of recipient = proposedRoleForRecipient
    // (recipient may override via theirRole). Recipient's view of sender =
    // proposedRoleForSender (recipient may override via myRole).
    const senderRoleForRecipient =
      data.theirRole ?? invitation.proposedRoleForRecipient ?? null;
    const recipientRoleForSender =
      data.myRole ?? invitation.proposedRoleForSender ?? null;

    const [aId, bId] = canonical(invitation.fromUserId, userId);
    const senderIsA = aId === invitation.fromUserId;
    const roleAForB = senderIsA ? senderRoleForRecipient : recipientRoleForSender;
    const roleBForA = senderIsA ? recipientRoleForSender : senderRoleForRecipient;

    // Transaction: create link, mark invitation accepted, add to groups (recipient side only).
    // @@unique([userAId, userBId]) prevents duplicates from concurrent accepts.
    let link;
    try {
      link = await this.db.$transaction(async (tx) => {
        const created = await tx.contactLink.create({
          data: {
            userAId: aId,
            userBId: bId,
            roleAForB,
            roleBForA,
            initiatedBy: invitation.fromUserId,
          },
        });

        await tx.contactInvitation.update({
          where: { id: invitation.id },
          data: { status: 'accepted', respondedAt: new Date() },
        });

        // Recipient can auto-add new link to their own groups.
        if (data.autoAddToCircleIds && data.autoAddToCircleIds.length > 0) {
          const myCircles = await tx.circle.findMany({
            where: { id: { in: data.autoAddToCircleIds }, ownerId: userId },
            select: { id: true },
          });
          if (myCircles.length > 0) {
            await tx.circleMembership.createMany({
              data: myCircles.map((c) => ({
                circleId: c.id,
                contactLinkId: created.id,
              })),
              skipDuplicates: true,
            });
          }
        }

        return created;
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002') {
        throw new ConflictException('Связь уже существует');
      }
      throw err;
    }

    const recipient = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });

    this.events.emit(
      'contact.invitation.accepted',
      {
        invitationId: invitation.id,
        contactLinkId: link.id,
        fromUserId: invitation.fromUserId,
        byUserId: userId,
        byName: formatName(recipient?.firstName ?? '', recipient?.lastName ?? null),
      },
      'contacts',
    );

    // Both sides gained a contact → bust cached /users/me (contactsCount).
    await Promise.all([
      this.redis.invalidateUserProfile(invitation.fromUserId),
      this.redis.invalidateUserProfile(userId),
    ]);

    const senderName = formatName(
      invitation.fromUser.firstName,
      invitation.fromUser.lastName,
    );
    const recipientName = formatName(
      recipient?.firstName ?? '',
      recipient?.lastName ?? null,
    );
    this.events.emit(
      'contact.linked',
      {
        contactLinkId: link.id,
        userIds: [invitation.fromUserId, userId],
        otherNameByUser: {
          [invitation.fromUserId]: recipientName,
          [userId]: senderName,
        },
      },
      'contacts',
    );

    return link;
  }

  async rejectInvitation(userId: string, invitationId: string) {
    const invitation = await this.db.contactInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation) throw new NotFoundException('Приглашение не найдено');
    if (invitation.toUserId !== userId) {
      throw new ForbiddenException('Это приглашение не для вас');
    }
    if (invitation.status !== 'pending') {
      throw new ConflictException('Приглашение уже обработано');
    }

    await this.db.contactInvitation.update({
      where: { id: invitation.id },
      data: { status: 'rejected', respondedAt: new Date() },
    });

    const recipient = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });

    this.events.emit(
      'contact.invitation.rejected',
      {
        invitationId: invitation.id,
        fromUserId: invitation.fromUserId,
        byUserId: userId,
        byName: formatName(recipient?.firstName ?? '', recipient?.lastName ?? null),
      },
      'contacts',
    );
  }

  async cancelInvitation(userId: string, invitationId: string) {
    const invitation = await this.db.contactInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation) throw new NotFoundException('Приглашение не найдено');
    if (invitation.fromUserId !== userId) {
      throw new ForbiddenException('Отменить может только отправитель');
    }
    if (invitation.status !== 'pending') {
      throw new ConflictException('Приглашение уже обработано');
    }

    await this.db.contactInvitation.update({
      where: { id: invitation.id },
      data: { status: 'cancelled', respondedAt: new Date() },
    });

    this.events.emit(
      'contact.invitation.cancelled',
      {
        invitationId: invitation.id,
        fromUserId: invitation.fromUserId,
        toUserId: invitation.toUserId,
        toPhone: invitation.toPhone,
      },
      'contacts',
    );
  }

  async resendInvitation(userId: string, invitationId: string) {
    const invitation = await this.db.contactInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation) throw new NotFoundException('Приглашение не найдено');
    if (invitation.fromUserId !== userId) {
      throw new ForbiddenException('Повторить может только отправитель');
    }
    if (!['cancelled', 'rejected', 'expired'].includes(invitation.status)) {
      throw new ConflictException('Это приглашение ещё активно');
    }

    const cooldownSince = new Date(
      Date.now() - CONTACT_LIMITS.resendCooldownHours * 60 * 60 * 1000,
    );
    if (invitation.updatedAt > cooldownSince) {
      const hours = CONTACT_LIMITS.resendCooldownHours;
      throw new BadRequestException(`Повторная отправка возможна через ${hours} часов`);
    }

    // Simply create a new invitation with the same details.
    return this.sendInvitation(userId, {
      toPhone: invitation.toPhone,
      proposedRoleForRecipient: invitation.proposedRoleForRecipient ?? undefined,
      proposedRoleForSender: invitation.proposedRoleForSender ?? undefined,
      message: invitation.message ?? undefined,
    });
  }

  async listIncomingInvitations(userId: string) {
    const invitations = await this.db.contactInvitation.findMany({
      // expiresAt guard: an invitation past its TTL is dead even before the
      // hourly cron flips its status — it must not look actionable in the UI.
      where: { toUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 200, // safety cap; pending invitations are bounded in practice
      include: {
        fromUser: { select: this.userCardSelect() },
      },
    });
    return invitations.map((inv) => ({
      ...this.serializeInvitation(inv),
      // No link/groups yet → sender's default visibility.
      from: this.toContactUserCard(
        inv.fromUser,
        resolveCardVisibility(inv.fromUser.cardVisibility as Partial<CardVisibility> | null),
      ),
    }));
  }

  async listOutgoingInvitations(userId: string) {
    const invitations = await this.db.contactInvitation.findMany({
      where: { fromUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: CONTACT_LIMITS.maxPendingOutgoingInvitations,
      include: {
        toUser: { select: this.userCardSelect() },
      },
    });
    return invitations.map((inv) => ({
      ...this.serializeInvitation(inv),
      to: inv.toUser
        ? this.toContactUserCard(
            inv.toUser,
            resolveCardVisibility(inv.toUser.cardVisibility as Partial<CardVisibility> | null),
          )
        : null,
    }));
  }

  /**
   * Called from AuthService.register after a new user is created.
   * Any pending invitations that targeted this phone get linked to the new
   * user_id and surfaced as notifications.
   */
  async activatePendingInvitationsForNewUser(userId: string, phone: string) {
    const pending = await this.db.contactInvitation.findMany({
      where: {
        toPhone: phone,
        toUserId: null,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: {
        fromUser: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
      },
    });
    if (pending.length === 0) return;

    await this.db.contactInvitation.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { toUserId: userId },
    });

    for (const inv of pending) {
      this.events.emit(
        'contact.invitation.activated',
        {
          invitationId: inv.id,
          fromUserId: inv.fromUserId,
          fromName: formatName(inv.fromUser.firstName, inv.fromUser.lastName),
          fromPhone: inv.fromUser.phone,
          toUserId: userId,
          toPhone: phone,
          proposedRoleForRecipient: inv.proposedRoleForRecipient,
          message: inv.message,
        },
        'contacts',
      );
    }
  }

  // ============================================================
  // Blocks
  // ============================================================

  async listBlocks(userId: string) {
    const blocks = await this.db.contactBlock.findMany({
      where: { blockerId: userId },
      include: {
        blocked: {
          select: { id: true, phone: true, firstName: true, lastName: true, avatar: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200, // safety cap
    });
    return blocks.map((b) => ({
      id: b.id,
      blockedUserId: b.blockedId,
      blockedPhone: b.blocked.phone,
      blockedFirstName: b.blocked.firstName,
      // The link is gone — only the initial, same as the pre-link lookup.
      blockedLastName: maskLastName(b.blocked.lastName),
      blockedAvatar: b.blocked.avatar,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  async blockUser(userId: string, targetUserId: string) {
    if (userId === targetUserId) {
      throw new BadRequestException('Нельзя заблокировать самого себя');
    }
    const target = await this.db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Пользователь не найден');

    const existing = await this.db.contactBlock.findUnique({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } },
    });
    if (existing) return existing;

    // Block implies removing any existing link between the two. Its group
    // memberships are loaded first (they cascade away with the link) so the
    // mirrored access tuples can be revoked immediately.
    const [a, b] = canonical(userId, targetUserId);
    const link = await this.db.contactLink.findUnique({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      include: { memberships: { select: this.membershipSelect() } },
    });
    await this.db.contactLink.deleteMany({
      where: { userAId: a, userBId: b },
    });
    if (link) await this.revokeMembershipTuples(link);
    // Даже без живой связи: блок обязан отозвать прямые гранты книг (могли задрейфовать).
    await this.revokeFinbookSharesBetween(userId, targetUserId);
    // And cancel any pending invitations between them.
    await this.db.contactInvitation.updateMany({
      where: {
        status: 'pending',
        OR: [
          { fromUserId: userId, toUserId: targetUserId },
          { fromUserId: targetUserId, toUserId: userId },
        ],
      },
      data: { status: 'cancelled', respondedAt: new Date() },
    });

    const block = await this.db.contactBlock.create({
      data: { blockerId: userId, blockedId: targetUserId },
    });

    this.events.emit(
      'contact.blocked',
      { blockerId: userId, blockedId: targetUserId },
      'contacts',
    );

    await Promise.all([
      this.redis.invalidateUserProfile(userId),
      this.redis.invalidateUserProfile(targetUserId),
    ]);
    return block;
  }

  /**
   * Cleanup: mark expired invitations and delete old non-pending ones.
   * Called by a cron job or manually.
   */
  async cleanupInvitations() {
    await this.db.contactInvitation.updateMany({
      where: { status: 'pending', expiresAt: { lt: new Date() } },
      data: { status: 'expired', respondedAt: new Date() },
    });

    // Non-pending rows are RETAINED for a window, not deleted on sight: the
    // resend cooldown (24h), the 30-per-24h send limit and resendInvitation
    // all read this history — deleting it hourly silently disabled all three.
    const retainSince = new Date(
      Date.now() - CONTACT_LIMITS.nonPendingRetentionDays * 24 * 60 * 60 * 1000,
    );
    await this.db.contactInvitation.deleteMany({
      where: { status: { not: 'pending' }, updatedAt: { lt: retainSince } },
    });
  }

  async unblockUser(userId: string, targetUserId: string) {
    await this.db.contactBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetUserId },
    });
    await Promise.all([
      this.redis.invalidateUserProfile(userId),
      this.redis.invalidateUserProfile(targetUserId),
    ]);
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  /**
   * Revoke the access-engine tuples mirrored from a deleted link's group
   * memberships (circle:<id>#member@user). The CircleMembership rows cascade
   * away with the ContactLink at the DB level, but without an explicit revoke
   * the removed person keeps everything granted to those Groups (per-Group
   * calendar sharing, showcases/wishlists shared to a Group) until the nightly
   * AccessReconcileCron. Best-effort: AccessProjectionService never throws —
   * a projection failure only logs, the reconciler is the safety net.
   */
  private async revokeMembershipTuples(link: {
    userAId: string;
    userBId: string;
    memberships: { circleId: string; circle: { ownerId: string } }[];
  }): Promise<void> {
    for (const m of link.memberships) {
      // The member is the side of the link opposite the Group owner.
      const memberId =
        m.circle.ownerId === link.userAId ? link.userBId : link.userAId;
      await this.accessProjection.circleMemberRemoved(m.circleId, memberId);
    }
  }

  private userCardSelect() {
    return {
      id: true,
      phone: true,
      firstName: true,
      lastName: true,
      avatar: true,
      dateOfBirth: true,
      bio: true,
      city: true,
      email: true,
      maritalStatus: true,
      socialLinks: true,
      cardVisibility: true, // owner's DEFAULT (ungrouped) visibility
    } as const;
  }

  private membershipSelect() {
    return {
      circleId: true,
      circle: { select: { ownerId: true, cardVisibility: true } },
    } as const;
  }

  private sideFor(
    userId: string,
    link: { userAId: string; userBId: string },
  ): 'A' | 'B' | null {
    if (link.userAId === userId) return 'A';
    if (link.userBId === userId) return 'B';
    return null;
  }

  /**
   * Effective visibility for the card OWNER as seen by the VIEWER:
   * union of the owner's groups that contain this link; if the viewer is
   * in none of the owner's groups → the owner's default visibility.
   */
  private resolveVisibilityForViewer(
    ownerId: string,
    ownerDefault: Prisma.JsonValue | null,
    memberships: {
      circle: { ownerId: string; cardVisibility: Prisma.JsonValue | null };
    }[],
  ): CardVisibility {
    const groupVis = memberships
      .filter((m) => m.circle.ownerId === ownerId)
      .map((m) =>
        resolveCardVisibility(
          m.circle.cardVisibility as Partial<CardVisibility> | null,
        ),
      );
    return groupVis.length > 0
      ? mergeVisibilities(groupVis)
      : resolveCardVisibility(ownerDefault as Partial<CardVisibility> | null);
  }

  private mapLinkToContact(
    link: {
      id: string;
      userAId: string;
      userBId: string;
      roleAForB: string | null;
      roleBForA: string | null;
      initiatedBy: string;
      confirmedAt: Date;
      userA: UserCardRow;
      userB: UserCardRow;
      memberships: {
        circleId: string;
        circle: { ownerId: string; cardVisibility: Prisma.JsonValue | null };
      }[];
    },
    requestingUserId: string,
  ): Contact {
    const side = this.sideFor(requestingUserId, link);
    if (!side) {
      throw new ForbiddenException('Нет доступа к этому контакту');
    }
    const them = side === 'A' ? link.userB : link.userA;
    const myRole = side === 'A' ? link.roleAForB : link.roleBForA;
    const theirRole = side === 'A' ? link.roleBForA : link.roleAForB;

    // Groups OF MINE that contain this contact (for UI chips).
    const myCircleIds = link.memberships
      .filter((m) => m.circle.ownerId === requestingUserId)
      .map((m) => m.circleId);

    // Visibility = how the OWNER (them) exposes their card to me, based on
    // which of THEM's groups I'm in (union), else them's default.
    const visibility = this.resolveVisibilityForViewer(
      them.id,
      them.cardVisibility,
      link.memberships,
    );

    return {
      linkId: link.id,
      them: this.toContactUserCard(them, visibility),
      myRole,
      theirRole,
      initiatedBy: link.initiatedBy,
      confirmedAt: link.confirmedAt.toISOString(),
      myCircleIds,
    };
  }

  /**
   * Build a ContactUserCard from a User row, applying an already-resolved
   * visibility. Always-visible fields (firstName, lastName, phone) are
   * never masked; optional fields are nulled out when hidden.
   */
  private toContactUserCard(
    row: UserCardRow,
    visibility: CardVisibility,
  ): ContactUserCard {
    return {
      id: row.id,
      phone: row.phone,
      firstName: row.firstName,
      lastName: row.lastName,
      avatar: row.avatar,
      dateOfBirth:
        visibility.dateOfBirth && row.dateOfBirth
          ? row.dateOfBirth.toISOString().slice(0, 10)
          : null,
      bio: visibility.bio ? (row.bio ?? null) : null,
      city: visibility.city ? (row.city ?? null) : null,
      email: visibility.email ? (row.email ?? null) : null,
      maritalStatus: visibility.maritalStatus ? (row.maritalStatus ?? null) : null,
      socialLinks: visibility.socialLinks && row.socialLinks
        ? (row.socialLinks as { telegram?: string; instagram?: string })
        : null,
      age: visibility.age && row.dateOfBirth ? calcAge(row.dateOfBirth) : null,
      showOnlineStatus: visibility.onlineStatus,
    };
  }

  private serializeInvitation(inv: {
    id: string;
    fromUserId: string;
    toUserId: string | null;
    toPhone: string;
    proposedRoleForSender: string | null;
    proposedRoleForRecipient: string | null;
    message: string | null;
    status: string;
    expiresAt: Date;
    respondedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: inv.id,
      fromUserId: inv.fromUserId,
      toUserId: inv.toUserId,
      toPhone: inv.toPhone,
      proposedRoleForSender: inv.proposedRoleForSender,
      proposedRoleForRecipient: inv.proposedRoleForRecipient,
      message: inv.message,
      status: inv.status as
        | 'pending'
        | 'accepted'
        | 'rejected'
        | 'cancelled'
        | 'expired',
      expiresAt: inv.expiresAt.toISOString(),
      respondedAt: inv.respondedAt ? inv.respondedAt.toISOString() : null,
      createdAt: inv.createdAt.toISOString(),
      updatedAt: inv.updatedAt.toISOString(),
    };
  }
}

// ------------------------------------------------------------
// Helpers (private to module)
// ------------------------------------------------------------

type UserCardRow = {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  dateOfBirth: Date | null;
  bio: string | null;
  city: string | null;
  email: string | null;
  maritalStatus: string | null;
  socialLinks: Prisma.JsonValue | null;
  cardVisibility: Prisma.JsonValue | null;
};

/** Canonical ordering: smaller UUID first. Enforced at the service layer. */
function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Opaque keyset cursor for the contacts list: "<ISO confirmedAt>_<id>". */
function encodeLinkCursor(confirmedAt: Date, id: string): string {
  return `${confirmedAt.toISOString()}_${id}`;
}

function decodeLinkCursor(
  cursor?: string,
): { confirmedAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf('_');
  if (idx === -1) return null;
  const confirmedAt = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(confirmedAt.getTime()) || !id) return null;
  return { confirmedAt, id };
}

function formatName(first: string, last: string | null): string {
  return last ? `${first} ${last}` : first;
}

function calcAge(dob: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}
