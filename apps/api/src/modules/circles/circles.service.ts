import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { ContactsService } from '../contacts/contacts.service';
import { CONTACT_LIMITS } from '@superapp/shared';

/**
 * CirclesService — owner-local "folders" over confirmed contacts.
 *
 * A Circle is NOT a group chat and NOT a shared space. It belongs to
 * exactly one owner and contains CircleMembership rows that reference
 * the owner's ContactLinks. The same ContactLink can sit in Circles of
 * both sides independently.
 *
 * All operations enforce ownerId — a user can only see / mutate their
 * own Circles.
 */
@Injectable()
export class CirclesService {
  constructor(
    private db: DatabaseService,
    private contacts: ContactsService,
  ) {}

  // ============================================================
  // Circle CRUD
  // ============================================================

  async listCircles(ownerId: string) {
    const circles = await this.db.circle.findMany({
      where: { ownerId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { memberships: true } },
      },
    });
    return circles.map((c) => ({
      id: c.id,
      ownerId: c.ownerId,
      name: c.name,
      icon: c.icon,
      color: c.color,
      sortOrder: c.sortOrder,
      membersCount: c._count.memberships,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async getCircle(ownerId: string, circleId: string) {
    const circle = await this.db.circle.findUnique({
      where: { id: circleId },
      include: {
        _count: { select: { memberships: true } },
        memberships: {
          select: { contactLinkId: true },
        },
      },
    });
    if (!circle) throw new NotFoundException('Окружение не найдено');
    if (circle.ownerId !== ownerId) {
      throw new ForbiddenException('Нет доступа к этому окружению');
    }

    // Resolve contact links to full Contact cards via ContactsService,
    // so the me/them view + cardVisibility logic stays in one place.
    const myContacts = await this.contacts.listContacts(ownerId);
    const byId = new Map(myContacts.map((c) => [c.linkId, c]));
    const members = circle.memberships
      .map((m) => byId.get(m.contactLinkId))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    return {
      id: circle.id,
      ownerId: circle.ownerId,
      name: circle.name,
      icon: circle.icon,
      color: circle.color,
      sortOrder: circle.sortOrder,
      membersCount: circle._count.memberships,
      createdAt: circle.createdAt.toISOString(),
      updatedAt: circle.updatedAt.toISOString(),
      members,
    };
  }

  async createCircle(
    ownerId: string,
    data: { name: string; icon?: string; color?: string; sortOrder?: number },
  ) {
    const existingCount = await this.db.circle.count({ where: { ownerId } });
    if (existingCount >= CONTACT_LIMITS.maxCirclesPerUser) {
      throw new BadRequestException(
        `Лимит окружений: ${CONTACT_LIMITS.maxCirclesPerUser}`,
      );
    }

    const sortOrder =
      data.sortOrder !== undefined ? data.sortOrder : existingCount;

    const circle = await this.db.circle.create({
      data: {
        ownerId,
        name: data.name,
        icon: data.icon ?? null,
        color: data.color ?? null,
        sortOrder,
      },
    });

    return this.serialize(circle, 0);
  }

  async updateCircle(
    ownerId: string,
    circleId: string,
    data: {
      name?: string;
      icon?: string | null;
      color?: string | null;
      sortOrder?: number;
    },
  ) {
    await this.assertOwned(ownerId, circleId);
    const updated = await this.db.circle.update({
      where: { id: circleId },
      data,
      include: { _count: { select: { memberships: true } } },
    });
    return this.serialize(updated, updated._count.memberships);
  }

  async deleteCircle(ownerId: string, circleId: string) {
    await this.assertOwned(ownerId, circleId);
    // Deleting the Circle cascades memberships but NOT the underlying
    // ContactLinks — contacts themselves are preserved.
    await this.db.circle.delete({ where: { id: circleId } });
  }

  async reorderCircles(
    ownerId: string,
    payload: Array<{ id: string; sortOrder: number }>,
  ) {
    // Verify every circle belongs to the owner in one query.
    const ids = payload.map((p) => p.id);
    const owned = await this.db.circle.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new ForbiddenException('Одно из окружений не принадлежит вам');
    }

    await this.db.$transaction(
      payload.map((p) =>
        this.db.circle.update({
          where: { id: p.id },
          data: { sortOrder: p.sortOrder },
        }),
      ),
    );
  }

  // ============================================================
  // Membership
  // ============================================================

  async addMember(ownerId: string, circleId: string, contactLinkId: string) {
    const circle = await this.assertOwned(ownerId, circleId);

    // Verify the contact link belongs to the owner (i.e. they are A or B).
    const link = await this.db.contactLink.findUnique({
      where: { id: contactLinkId },
      select: { id: true, userAId: true, userBId: true },
    });
    if (!link) throw new NotFoundException('Контакт не найден');
    if (link.userAId !== ownerId && link.userBId !== ownerId) {
      throw new ForbiddenException('Это не ваш контакт');
    }

    const currentCount = await this.db.circleMembership.count({
      where: { circleId },
    });
    if (currentCount >= CONTACT_LIMITS.maxMembersPerCircle) {
      throw new BadRequestException(
        `Лимит участников в окружении: ${CONTACT_LIMITS.maxMembersPerCircle}`,
      );
    }

    try {
      await this.db.circleMembership.create({
        data: { circleId, contactLinkId },
      });
    } catch (err) {
      // Prisma unique violation P2002 — already in the circle.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException('Контакт уже в этом окружении');
      }
      throw err;
    }
    return { circleId: circle.id, contactLinkId };
  }

  async removeMember(ownerId: string, circleId: string, contactLinkId: string) {
    await this.assertOwned(ownerId, circleId);
    const result = await this.db.circleMembership.deleteMany({
      where: { circleId, contactLinkId },
    });
    if (result.count === 0) {
      throw new NotFoundException('Контакт не найден в этом окружении');
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async assertOwned(ownerId: string, circleId: string) {
    const circle = await this.db.circle.findUnique({ where: { id: circleId } });
    if (!circle) throw new NotFoundException('Окружение не найдено');
    if (circle.ownerId !== ownerId) {
      throw new ForbiddenException('Нет доступа к этому окружению');
    }
    return circle;
  }

  private serialize(
    circle: {
      id: string;
      ownerId: string;
      name: string;
      icon: string | null;
      color: string | null;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
    },
    membersCount: number,
  ) {
    return {
      id: circle.id,
      ownerId: circle.ownerId,
      name: circle.name,
      icon: circle.icon,
      color: circle.color,
      sortOrder: circle.sortOrder,
      membersCount,
      createdAt: circle.createdAt.toISOString(),
      updatedAt: circle.updatedAt.toISOString(),
    };
  }
}
