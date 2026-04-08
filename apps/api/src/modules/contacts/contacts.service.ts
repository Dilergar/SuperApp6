import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  CONTACT_LIMITS,
  resolveCardVisibility,
  type CardVisibility,
  type RelationshipType,
  type Contact,
  type ContactUserCard,
} from '@superapp/shared';
import type { Prisma } from '@prisma/client';

/**
 * ContactsService — the bilateral social-graph core.
 *
 * Responsibilities:
 *   - Canonical ordering (userAId < userBId) for every ContactLink write.
 *   - Invitation lifecycle: send / accept / reject / cancel / resend,
 *     including throttling and blocks.
 *   - External invitations: toUserId can be null until the recipient
 *     registers; activatePendingInvitationsForNewUser is called from
 *     AuthService.register and wires them back in.
 *   - Emits events on EventBus — modules like notifications hook in
 *     without any direct dependency on this service.
 *
 * Rules encoded here (not in Prisma):
 *   - Canonical ordering userA < userB.
 *   - Throttle: CONTACT_LIMITS.maxInvitationsPer24h outgoing / 24h.
 *   - Resend cooldown: CONTACT_LIMITS.resendCooldownHours.
 *   - Max pending outgoing: CONTACT_LIMITS.maxPendingOutgoingInvitations.
 */
@Injectable()
export class ContactsService {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
  ) {}

  // ============================================================
  // Contacts — list / read / update / delete
  // ============================================================

  /** All confirmed contacts for a user, mapped to the me/them view. */
  async listContacts(userId: string): Promise<Contact[]> {
    const links = await this.db.contactLink.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      include: {
        userA: {
          select: this.userCardSelect(),
        },
        userB: {
          select: this.userCardSelect(),
        },
        memberships: {
          select: { circleId: true, circle: { select: { ownerId: true } } },
        },
      },
      orderBy: { confirmedAt: 'desc' },
    });

    return links.map((link) => this.mapLinkToContact(link, userId));
  }

  async getContact(userId: string, linkId: string): Promise<Contact> {
    const link = await this.db.contactLink.findUnique({
      where: { id: linkId },
      include: {
        userA: { select: this.userCardSelect() },
        userB: { select: this.userCardSelect() },
        memberships: {
          select: { circleId: true, circle: { select: { ownerId: true } } },
        },
      },
    });
    if (!link) throw new NotFoundException('Контакт не найден');
    if (link.userAId !== userId && link.userBId !== userId) {
      throw new ForbiddenException('Нет доступа к этому контакту');
    }
    return this.mapLinkToContact(link, userId);
  }

  async updateContact(
    userId: string,
    linkId: string,
    data: { myLabelForThem?: string | null; relationshipType?: RelationshipType },
  ) {
    const link = await this.db.contactLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Контакт не найден');
    const side = this.sideFor(userId, link);
    if (!side) throw new ForbiddenException('Нет доступа к этому контакту');

    const patch: Prisma.ContactLinkUpdateInput = {};
    if (data.myLabelForThem !== undefined) {
      // Only my own label (the one I put on them on my card).
      if (side === 'A') patch.labelAForB = data.myLabelForThem;
      else patch.labelBForA = data.myLabelForThem;
    }
    if (data.relationshipType !== undefined) {
      // relationshipType is shared — either side can update the broad bucket.
      patch.relationshipType = data.relationshipType;
    }

    const updated = await this.db.contactLink.update({
      where: { id: linkId },
      data: patch,
      include: {
        userA: { select: this.userCardSelect() },
        userB: { select: this.userCardSelect() },
        memberships: {
          select: { circleId: true, circle: { select: { ownerId: true } } },
        },
      },
    });
    return this.mapLinkToContact(updated, userId);
  }

  async deleteContact(userId: string, linkId: string) {
    const link = await this.db.contactLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Контакт не найден');
    if (link.userAId !== userId && link.userBId !== userId) {
      throw new ForbiddenException('Нет доступа к этому контакту');
    }

    await this.db.contactLink.delete({ where: { id: linkId } });

    this.events.emit(
      'contact.removed',
      {
        contactLinkId: linkId,
        userIds: [link.userAId, link.userBId],
        removedBy: userId,
      },
      'contacts',
    );
  }

  // ============================================================
  // Invitations
  // ============================================================

  async sendInvitation(
    fromUserId: string,
    data: {
      toPhone: string;
      relationshipType: RelationshipType;
      proposedLabelForRecipient?: string;
      proposedLabelForSender?: string;
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
        throw new ConflictException('Этот пользователь уже в ваших контактах');
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
        proposedLabelForRecipient: data.proposedLabelForRecipient ?? null,
        proposedLabelForSender: data.proposedLabelForSender ?? null,
        relationshipType: data.relationshipType,
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
        proposedLabelForRecipient: invitation.proposedLabelForRecipient,
        relationshipType: invitation.relationshipType,
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
      myLabelForThem?: string;
      theirLabelForMe?: string;
      relationshipType?: RelationshipType;
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

    // Resolve labels. Sender's side is proposedLabelForRecipient (how sender calls recipient).
    // Recipient's side is proposedLabelForSender (how recipient calls sender).
    const senderLabelForRecipient =
      data.theirLabelForMe ?? invitation.proposedLabelForRecipient ?? null;
    const recipientLabelForSender =
      data.myLabelForThem ?? invitation.proposedLabelForSender ?? null;

    const [aId, bId] = canonical(invitation.fromUserId, userId);
    const senderIsA = aId === invitation.fromUserId;
    const labelAForB = senderIsA ? senderLabelForRecipient : recipientLabelForSender;
    const labelBForA = senderIsA ? recipientLabelForSender : senderLabelForRecipient;

    const relationshipType = data.relationshipType ?? invitation.relationshipType;

    // Transaction: create link, mark invitation accepted, add to circles (recipient side only).
    const link = await this.db.$transaction(async (tx) => {
      const created = await tx.contactLink.create({
        data: {
          userAId: aId,
          userBId: bId,
          labelAForB,
          labelBForA,
          relationshipType,
          initiatedBy: invitation.fromUserId,
        },
      });

      await tx.contactInvitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted', respondedAt: new Date() },
      });

      // Recipient can auto-add new link to their own circles.
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
      relationshipType: invitation.relationshipType as RelationshipType,
      proposedLabelForRecipient: invitation.proposedLabelForRecipient ?? undefined,
      proposedLabelForSender: invitation.proposedLabelForSender ?? undefined,
      message: invitation.message ?? undefined,
    });
  }

  async listIncomingInvitations(userId: string) {
    const invitations = await this.db.contactInvitation.findMany({
      where: { toUserId: userId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: {
        fromUser: { select: this.userCardSelect() },
      },
    });
    return invitations.map((inv) => ({
      ...this.serializeInvitation(inv),
      from: this.toContactUserCard(inv.fromUser, {}),
    }));
  }

  async listOutgoingInvitations(userId: string) {
    const invitations = await this.db.contactInvitation.findMany({
      where: { fromUserId: userId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: {
        toUser: { select: this.userCardSelect() },
      },
    });
    return invitations.map((inv) => ({
      ...this.serializeInvitation(inv),
      to: inv.toUser ? this.toContactUserCard(inv.toUser, {}) : null,
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
          proposedLabelForRecipient: inv.proposedLabelForRecipient,
          relationshipType: inv.relationshipType,
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
          select: { id: true, phone: true, firstName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return blocks.map((b) => ({
      id: b.id,
      blockedUserId: b.blockedId,
      blockedPhone: b.blocked.phone,
      blockedFirstName: b.blocked.firstName,
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

    // Block implies removing any existing link between the two.
    const [a, b] = canonical(userId, targetUserId);
    await this.db.contactLink.deleteMany({
      where: { userAId: a, userBId: b },
    });
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
    return block;
  }

  async unblockUser(userId: string, targetUserId: string) {
    await this.db.contactBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetUserId },
    });
  }

  // ============================================================
  // Internal helpers
  // ============================================================

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
      cardVisibility: true,
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

  private mapLinkToContact(
    link: {
      id: string;
      userAId: string;
      userBId: string;
      labelAForB: string | null;
      labelBForA: string | null;
      relationshipType: string;
      initiatedBy: string;
      confirmedAt: Date;
      userA: UserCardRow;
      userB: UserCardRow;
      memberships: { circleId: string; circle: { ownerId: string } }[];
    },
    requestingUserId: string,
  ): Contact {
    const side = this.sideFor(requestingUserId, link);
    if (!side) {
      throw new ForbiddenException('Нет доступа к этому контакту');
    }
    const them = side === 'A' ? link.userB : link.userA;
    const myLabelForThem = side === 'A' ? link.labelAForB : link.labelBForA;
    const theirLabelForMe = side === 'A' ? link.labelBForA : link.labelAForB;

    const myCircleIds = link.memberships
      .filter((m) => m.circle.ownerId === requestingUserId)
      .map((m) => m.circleId);

    return {
      linkId: link.id,
      relationshipType: link.relationshipType as RelationshipType,
      them: this.toContactUserCard(them, {}),
      myLabelForThem,
      theirLabelForMe,
      initiatedBy: link.initiatedBy,
      confirmedAt: link.confirmedAt.toISOString(),
      myCircleIds,
    };
  }

  /**
   * Build a ContactUserCard from a User row, applying the card owner's
   * cardVisibility. Always-visible fields (firstName, lastName, phone) are
   * never masked; optional fields are nulled out when the owner has them
   * hidden.
   */
  private toContactUserCard(
    row: UserCardRow,
    _ctx: Record<string, unknown>,
  ): ContactUserCard {
    const visibility = resolveCardVisibility(
      row.cardVisibility as Partial<CardVisibility> | null,
    );
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
    };
  }

  private serializeInvitation(inv: {
    id: string;
    fromUserId: string;
    toUserId: string | null;
    toPhone: string;
    proposedLabelForSender: string | null;
    proposedLabelForRecipient: string | null;
    relationshipType: string;
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
      proposedLabelForSender: inv.proposedLabelForSender,
      proposedLabelForRecipient: inv.proposedLabelForRecipient,
      relationshipType: inv.relationshipType as RelationshipType,
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

function formatName(first: string, last: string | null): string {
  return last ? `${first} ${last}` : first;
}
