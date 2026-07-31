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
import { AccessProjectionService } from '../../core/access/access-projection.service';
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
    private accessProjection: AccessProjectionService,
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
      // Счётчик берём из фактически отданного состава, а не из `_count`: тот
      // считает ВСЕ строки членства, а резолв дополнительно отсекает связи, где
      // владелец не является стороной, — и числа расходились молча.
      ...this.serialize(circle, members.length),
      members,
    };
  }

  async createCircle(
    ownerId: string,
    data: { name: string; icon?: string; color?: string; sortOrder?: number },
  ) {
    // Потолок групп проверяется и применяется под блокировкой строки владельца —
    // иначе параллельные создания оба видят «лимит не достигнут» и переступают его.
    const circle = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`,
      );
      const existingCount = await tx.circle.count({ where: { ownerId } });
      if (existingCount >= CONTACT_LIMITS.maxCirclesPerUser) {
        throw new BadRequestException(
          `Лимит групп: ${CONTACT_LIMITS.maxCirclesPerUser}`,
        );
      }

      const sortOrder =
        data.sortOrder !== undefined ? data.sortOrder : existingCount;

      return tx.circle.create({
        data: {
          ownerId,
          name: data.name,
          icon: data.icon ?? null,
          color: data.color ?? null,
          sortOrder,
        },
      });
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
    await this.assertOwned(ownerId, circleId);

    const { cardVisibility, ...rest } = data;

    const { updated, prevCalendarVisibility } = await this.db.$transaction(
      async (tx) => {
        // Строка блокируется на время «прочитал → слил → записал»: карта видимости
        // мержится НАД текущей, и два параллельных частичных PATCH без блокировки
        // теряли одно из переключений (классический read-modify-write).
        const locked = await tx.$queryRaw<
          Array<{ card_visibility: unknown; calendar_visibility: string }>
        >(
          Prisma.sql`SELECT card_visibility, calendar_visibility FROM circles WHERE id = ${circleId} FOR UPDATE`,
        );
        if (locked.length === 0) throw new NotFoundException('Группа не найдена');
        const current = locked[0];

        const updateData: Prisma.CircleUpdateInput = { ...rest };
        if (cardVisibility !== undefined) {
          if (cardVisibility === null) {
            // Сброс в «наследовать дефолт владельца» (ContactsService резолвит
            // null именно так — это НЕ платформенные дефолты).
            updateData.cardVisibility = Prisma.JsonNull;
          } else {
            // Store the FULL resolved map (merged over current) so union and
            // reads are predictable.
            //
            // База для ПЕРВОЙ настройки группы — дефолт ВЛАДЕЛЬЦА, а не
            // платформенный: группа рождается с null, и мерж поверх платформенных
            // дефолтов (где био/возраст/соцсети открыты) означал, что первый же
            // тумблер в редакторе открывал заодно всё, что человек прятал в анкете.
            // Это та же ошибка, что была на чтении, только со стороны записи.
            let baseSource = current.card_visibility;
            if (baseSource === null) {
              const owner = await tx.user.findUnique({
                where: { id: ownerId },
                select: { cardVisibility: true },
              });
              baseSource = owner?.cardVisibility ?? null;
            }
            const base = resolveCardVisibility(
              baseSource as Partial<CardVisibility> | null,
            );
            updateData.cardVisibility = resolveCardVisibility({
              ...base,
              ...cardVisibility,
              extras: { ...(base.extras ?? {}), ...(cardVisibility.extras ?? {}) },
            }) as unknown as Prisma.InputJsonValue;
          }
        }

        const row = await tx.circle.update({
          where: { id: circleId },
          data: updateData,
          include: { _count: { select: { memberships: true } } },
        });
        return { updated: row, prevCalendarVisibility: current.calendar_visibility };
      },
    );

    // Phase 2 (Calendar): mirror this Group's calendar visibility into the access engine.
    // Только при РЕАЛЬНОЙ смене уровня: повторный PATCH тем же значением стоил
    // двух удалений, upsert'а и трёх бампов эпохи календаря на пустом месте.
    if (
      data.calendarVisibility !== undefined &&
      data.calendarVisibility !== prevCalendarVisibility
    ) {
      await this.accessProjection.circleCalendarVisibilityChanged(circleId, ownerId, data.calendarVisibility);
    }
    return this.serialize(updated, updated._count.memberships);
  }

  async deleteCircle(ownerId: string, circleId: string) {
    await this.assertOwned(ownerId, circleId);
    // Удаление группы и снятие её рёбер — в ОДНОЙ транзакции. Раньше строка
    // коммитилась первой, а отзыв шёл отдельным «best-effort» вызовом после:
    // падение процесса между ними оставляло и членство `circle#member@user`,
    // и гранты «участникам группы» живыми — до ночной сверки в 4:00 бывшие
    // участники удалённой группы сохраняли календарь, витрины и книги.
    await this.db.$transaction(async (tx) => {
      // Deleting the Group cascades memberships but NOT the underlying
      // ContactLinks — contacts themselves are preserved.
      await tx.circle.delete({ where: { id: circleId } });
      await this.accessProjection.circleDeleted(circleId, tx);
    });
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

    try {
      // Подсчёт и вставка — в одной транзакции под блокировкой строки группы:
      // раздельные count + create позволяли параллельным запросам переступить
      // потолок (оба видели «мест хватает»).
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM circles WHERE id = ${circleId} FOR UPDATE`,
        );
        const currentCount = await tx.circleMembership.count({ where: { circleId } });
        if (currentCount >= CONTACT_LIMITS.maxMembersPerCircle) {
          throw new BadRequestException(
            `Лимит участников в группе: ${CONTACT_LIMITS.maxMembersPerCircle}`,
          );
        }
        await tx.circleMembership.create({
          data: { circleId, contactLinkId },
        });
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
    // Phase 1: mirror the membership edge into the access engine (best-effort).
    // The member is the side of the link opposite the group owner.
    const memberId = link.userAId === ownerId ? link.userBId : link.userAId;
    await this.accessProjection.circleMemberAdded(circleId, memberId);
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
    // Phase 1: remove the mirrored membership edge (best-effort).
    const link = await this.db.contactLink.findUnique({
      where: { id: contactLinkId },
      select: { userAId: true, userBId: true },
    });
    if (link) {
      const memberId = link.userAId === ownerId ? link.userBId : link.userAId;
      await this.accessProjection.circleMemberRemoved(circleId, memberId);
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
