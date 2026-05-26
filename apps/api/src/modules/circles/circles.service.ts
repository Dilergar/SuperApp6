import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { ContactsService } from '../contacts/contacts.service';
import {
  CONTACT_LIMITS,
  resolveCardVisibility,
  type CardVisibility,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';

/**
 * CirclesService — owner-local GROUPS ("Группы") of confirmed contacts.
 *
 * A Group belongs to exactly one owner and contains CircleMembership rows
 * that reference the owner's ContactLinks (manual membership). The same
 * ContactLink can sit in Groups of both sides independently.
 *
 * Each Group carries its own card visibility — what its members may see
 * of the owner's card. Resolution (union across the viewer's groups, or
 * the owner's default when ungrouped) lives in ContactsService.
 *
 * All operations enforce ownerId.
 */
@Injectable()
export class CirclesService {
  constructor(
    private db: DatabaseService,
    private contacts: ContactsService,
    private redis: RedisService,
  ) {}

  // ============================================================
  // Group CRUD
  // ============================================================

  async listCircles(ownerId: string) {
    const circles = await this.db.circle.findMany({
      where: { ownerId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { memberships: true } },
      },
    });
    return circles.map((c) => this.serialize(c, c._count.memberships));
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
    if (!circle) throw new NotFoundException('Группа не найдена');
    if (circle.ownerId !== ownerId) {
      throw new ForbiddenException('Нет доступа к этой группе');
    }

    // Resolve only THIS group's membership links to full Contact cards via
    // ContactsService (keeps me/them + visibility logic in one place) instead
    // of loading the owner's entire environment.
    const linkIds = circle.memberships.map((m) => m.contactLinkId);
    const members = await this.contacts.listContactsByLinkIds(ownerId, linkIds);

    return {
      ...this.serialize(circle, circle._count.memberships),
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
        `Лимит групп: ${CONTACT_LIMITS.maxCirclesPerUser}`,
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

    await this.redis.invalidateUserProfile(ownerId);
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
      cardVisibility?: Partial<CardVisibility> | null;
      calendarVisibility?: 'none' | 'busy' | 'detailed';
    },
  ) {
    const circle = await this.assertOwned(ownerId, circleId);

    const { cardVisibility, ...rest } = data;
    const updateData: Prisma.CircleUpdateInput = { ...rest };

    if (cardVisibility !== undefined) {
      if (cardVisibility === null) {
        // Reset to "use owner default".
        updateData.cardVisibility = Prisma.JsonNull;
      } else {
        // Store the FULL resolved map (merged over current) so union and
        // reads are predictable.
        const current = resolveCardVisibility(
          circle.cardVisibility as Partial<CardVisibility> | null,
        );
        updateData.cardVisibility = resolveCardVisibility({
          ...current,
          ...cardVisibility,
          extras: { ...(current.extras ?? {}), ...(cardVisibility.extras ?? {}) },
        }) as unknown as Prisma.InputJsonValue;
      }
    }

    const updated = await this.db.circle.update({
      where: { id: circleId },
      data: updateData,
      include: { _count: { select: { memberships: true } } },
    });
    return this.serialize(updated, updated._count.memberships);
  }

  async deleteCircle(ownerId: string, circleId: string) {
    await this.assertOwned(ownerId, circleId);
    // Deleting the Group cascades memberships but NOT the underlying
    // ContactLinks — contacts themselves are preserved.
    await this.db.circle.delete({ where: { id: circleId } });
    await this.redis.invalidateUserProfile(ownerId);
  }

  async reorderCircles(
    ownerId: string,
    payload: Array<{ id: string; sortOrder: number }>,
  ) {
    const ids = payload.map((p) => p.id);
    const owned = await this.db.circle.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new ForbiddenException('Одна из групп не принадлежит вам');
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
        `Лимит участников в группе: ${CONTACT_LIMITS.maxMembersPerCircle}`,
      );
    }

    try {
      await this.db.circleMembership.create({
        data: { circleId, contactLinkId },
      });
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException('Контакт уже в этой группе');
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
      throw new NotFoundException('Контакт не найден в этой группе');
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async assertOwned(ownerId: string, circleId: string) {
    const circle = await this.db.circle.findUnique({ where: { id: circleId } });
    if (!circle) throw new NotFoundException('Группа не найдена');
    if (circle.ownerId !== ownerId) {
      throw new ForbiddenException('Нет доступа к этой группе');
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
      cardVisibility: Prisma.JsonValue | null;
      calendarVisibility: string;
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
      cardVisibility: resolveCardVisibility(
        circle.cardVisibility as Partial<CardVisibility> | null,
      ),
      calendarVisibility: (circle.calendarVisibility as 'none' | 'busy' | 'detailed') ?? 'none',
      createdAt: circle.createdAt.toISOString(),
      updatedAt: circle.updatedAt.toISOString(),
    };
  }
}
