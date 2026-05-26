import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Resource as ResourceRow } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import type {
  Resource as ResourceDto,
  ResourceBooking,
  ResourceBookingStatus,
  ResourceType,
  CreateResourceRequest,
  UpdateResourceRequest,
} from '@superapp/shared';

const fullName = (u: { firstName: string; lastName: string | null }) =>
  `${u.firstName} ${u.lastName ?? ''}`.trim();

const ACTIVE: ResourceBookingStatus[] = ['pending', 'confirmed'];

@Injectable()
export class ResourcesService {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
  ) {}

  // ============================================================
  // CRUD
  // ============================================================

  async create(ownerId: string, data: CreateResourceRequest): Promise<ResourceDto> {
    const r = await this.db.resource.create({
      data: {
        ownerId,
        name: data.name,
        type: data.type ?? 'other',
        capacity: data.capacity ?? 1,
        bookerUserIds: data.bookerUserIds ?? [],
        bookerCircleIds: data.bookerCircleIds ?? [],
      },
    });
    return this.toDto(r, ownerId, []);
  }

  async update(ownerId: string, id: string, data: UpdateResourceRequest): Promise<ResourceDto> {
    await this.assertOwned(ownerId, id);
    const r = await this.db.resource.update({
      where: { id },
      data: {
        name: data.name,
        type: data.type,
        capacity: data.capacity,
        bookerUserIds: data.bookerUserIds,
        bookerCircleIds: data.bookerCircleIds,
      },
    });
    return this.toDto(r, ownerId, []);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.assertOwned(ownerId, id);
    await this.db.resource.delete({ where: { id } }); // bookings keep their rows; resourceId set null
  }

  /** Resources I own + resources I'm allowed to book. */
  async list(userId: string): Promise<ResourceDto[]> {
    const myCircleIds = await this.myMemberCircleIds(userId);
    const resources = await this.db.resource.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { bookerUserIds: { has: userId } },
          myCircleIds.length ? { bookerCircleIds: { hasSome: myCircleIds } } : { id: '___none___' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    return resources.map((r) => this.toDto(r, userId, myCircleIds));
  }

  /** Bookings of one resource in a range (owner sees booker names; others see "Занято"). */
  async schedule(userId: string, id: string, fromISO: string, toISO: string): Promise<ResourceBooking[]> {
    const resource = await this.db.resource.findUnique({ where: { id } });
    if (!resource) throw new NotFoundException('Ресурс не найден');
    const isOwner = resource.ownerId === userId;
    if (!isOwner && !(await this.canBook(resource, userId))) {
      throw new ForbiddenException('Нет доступа к ресурсу');
    }
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const evs = await this.db.calendarEvent.findMany({
      where: {
        resourceId: id,
        resourceStatus: { in: ACTIVE },
        startTime: { lt: to },
        endTime: { gt: from },
      },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { startTime: 'asc' },
    });
    return evs.map((e) => this.bookingDto(e, resource.name, isOwner));
  }

  /** Pending booking requests across all my resources (the approvals queue). */
  async incomingRequests(ownerId: string): Promise<ResourceBooking[]> {
    const evs = await this.db.calendarEvent.findMany({
      where: { resourceStatus: 'pending', resource: { ownerId } },
      include: {
        user: { select: { firstName: true, lastName: true } },
        resource: { select: { name: true } },
      },
      orderBy: { startTime: 'asc' },
      take: 200,
    });
    return evs.map((e) => this.bookingDto(e, e.resource?.name ?? '—', true));
  }

  // ============================================================
  // Booking lifecycle (called by CalendarService + controller)
  // ============================================================

  /**
   * Validate a (new/changed) booking: booker is allowed and the slot has capacity.
   * Returns the status to store: owner's own booking is auto-confirmed; others pend.
   */
  async prepareBooking(
    resourceId: string,
    bookerId: string,
    start: Date,
    end: Date,
    excludeEventId?: string,
  ): Promise<{ status: ResourceBookingStatus; ownerId: string; name: string }> {
    const resource = await this.db.resource.findUnique({ where: { id: resourceId } });
    if (!resource) throw new NotFoundException('Ресурс не найден');
    if (resource.ownerId !== bookerId && !(await this.canBook(resource, bookerId))) {
      throw new ForbiddenException('Нет доступа к бронированию этого ресурса');
    }
    const active = await this.countActive(resourceId, start, end, excludeEventId);
    if (active >= resource.capacity) {
      throw new ConflictException('Ресурс занят в это время');
    }
    return {
      status: resource.ownerId === bookerId ? 'confirmed' : 'pending',
      ownerId: resource.ownerId,
      name: resource.name,
    };
  }

  async confirm(ownerId: string, eventId: string): Promise<void> {
    const ev = await this.loadBookingForOwner(ownerId, eventId);
    if (ev.resourceStatus !== 'pending') {
      throw new BadRequestException('Заявка не в статусе ожидания');
    }
    const confirmed = await this.db.calendarEvent.count({
      where: {
        resourceId: ev.resourceId!,
        resourceStatus: 'confirmed',
        id: { not: eventId },
        startTime: { lt: ev.endTime },
        endTime: { gt: ev.startTime },
      },
    });
    if (confirmed >= ev.resource!.capacity) {
      throw new ConflictException('В это время ресурс уже занят подтверждёнными бронями');
    }
    await this.db.calendarEvent.update({ where: { id: eventId }, data: { resourceStatus: 'confirmed' } });
    this.events.emit(
      'calendar.resource.confirmed',
      { recipientIds: [ev.userId], resourceName: ev.resource!.name, eventTitle: ev.title, eventId, byUserId: ownerId },
      'calendar',
    );
  }

  async reject(ownerId: string, eventId: string): Promise<void> {
    const ev = await this.loadBookingForOwner(ownerId, eventId);
    await this.db.calendarEvent.update({ where: { id: eventId }, data: { resourceStatus: 'rejected' } });
    this.events.emit(
      'calendar.resource.rejected',
      { recipientIds: [ev.userId], resourceName: ev.resource!.name, eventTitle: ev.title, eventId, byUserId: ownerId },
      'calendar',
    );
  }

  /** Emit the "requested" notification to a resource owner after a pending booking is created. */
  emitRequested(ownerId: string, bookerId: string, resourceName: string, eventTitle: string, eventId: string): void {
    this.events.emit(
      'calendar.resource.requested',
      { recipientIds: [ownerId], byUserId: bookerId, resourceName, eventTitle, eventId },
      'calendar',
    );
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async loadBookingForOwner(ownerId: string, eventId: string) {
    const ev = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      include: { resource: { select: { ownerId: true, name: true, capacity: true } } },
    });
    if (!ev || !ev.resource) throw new NotFoundException('Бронь не найдена');
    if (ev.resource.ownerId !== ownerId) throw new ForbiddenException('Вы не владелец ресурса');
    return ev;
  }

  private async countActive(resourceId: string, start: Date, end: Date, excludeEventId?: string): Promise<number> {
    return this.db.calendarEvent.count({
      where: {
        resourceId,
        resourceStatus: { in: ACTIVE },
        ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
        startTime: { lt: end },
        endTime: { gt: start },
      },
    });
  }

  private async canBook(resource: ResourceRow, userId: string): Promise<boolean> {
    if (resource.ownerId === userId) return true;
    if (resource.bookerUserIds.includes(userId)) return true;
    if (resource.bookerCircleIds.length === 0) return false;
    const myCircleIds = await this.myMemberCircleIds(userId);
    return resource.bookerCircleIds.some((c) => myCircleIds.includes(c));
  }

  /** Circle ids (owned by other people) that currently contain `userId` via a ContactLink. */
  private async myMemberCircleIds(userId: string): Promise<string[]> {
    const links = await this.db.contactLink.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      include: { memberships: { select: { circleId: true, circle: { select: { ownerId: true } } } } },
    });
    const ids: string[] = [];
    for (const l of links) {
      const other = l.userAId === userId ? l.userBId : l.userAId;
      for (const m of l.memberships) if (m.circle.ownerId === other) ids.push(m.circleId);
    }
    return [...new Set(ids)];
  }

  private async assertOwned(ownerId: string, id: string): Promise<ResourceRow> {
    const r = await this.db.resource.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Ресурс не найден');
    if (r.ownerId !== ownerId) throw new ForbiddenException('Вы не владелец ресурса');
    return r;
  }

  private toDto(r: ResourceRow, viewerId: string, myCircleIds: string[]): ResourceDto {
    const canBook =
      r.ownerId === viewerId ||
      r.bookerUserIds.includes(viewerId) ||
      r.bookerCircleIds.some((c) => myCircleIds.includes(c));
    return {
      id: r.id,
      ownerId: r.ownerId,
      name: r.name,
      type: r.type as ResourceType,
      capacity: r.capacity,
      bookerUserIds: r.bookerUserIds,
      bookerCircleIds: r.bookerCircleIds,
      isOwner: r.ownerId === viewerId,
      canBook,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private bookingDto(
    e: { id: string; title: string; startTime: Date; endTime: Date; userId: string; resourceId: string | null; resourceStatus: string | null; user: { firstName: string; lastName: string | null } },
    resourceName: string,
    revealBooker: boolean,
  ): ResourceBooking {
    return {
      eventId: e.id,
      resourceId: e.resourceId ?? '',
      resourceName,
      title: revealBooker ? e.title : 'Занято',
      start: e.startTime.toISOString(),
      end: e.endTime.toISOString(),
      bookerId: e.userId,
      bookerName: revealBooker ? fullName(e.user) : 'Занято',
      status: (e.resourceStatus as ResourceBookingStatus) ?? 'confirmed',
    };
  }
}
