import { Injectable } from '@nestjs/common';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { Prisma, Resource as ResourceRow } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { fullName } from '../../shared/utils/user-name';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ContactsService } from '../contacts/contacts.service';
import type {
  Resource as ResourceDto,
  ResourceBooking,
  ResourceBookingStatus,
  ResourceType,
  CreateResourceInput,
  UpdateResourceInput,
} from '@superapp/shared';

const ACTIVE: ResourceBookingStatus[] = ['pending', 'confirmed'];

@Injectable()
export class ResourcesService {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private contacts: ContactsService,
    private i18n: I18nService,
  ) {}

  // ============================================================
  // CRUD
  // ============================================================

  async create(ownerId: string, data: CreateResourceInput): Promise<ResourceDto> {
    await this.assertBookersAllowed(ownerId, data.bookerUserIds, data.bookerCircleIds);
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

  async update(ownerId: string, id: string, data: UpdateResourceInput): Promise<ResourceDto> {
    await this.assertOwned(ownerId, id);
    await this.assertBookersAllowed(ownerId, data.bookerUserIds, data.bookerCircleIds);
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
    // Разбор «в каких ЧУЖИХ Группах я состою» — единственной копией в ContactsService:
    // локальный обход contactLink+memberships мимо сервиса графа расходился бы с ним
    // при любой правке модели членства.
    const myCircleIds = await this.contacts.listCircleIdsWhereMember(userId);
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
    if (!resource) throw notFound('resource.notFound');
    const isOwner = resource.ownerId === userId;
    if (!isOwner && !(await this.canBook(resource, userId))) {
      throw forbidden('resource.noAccess');
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
    tx?: Prisma.TransactionClient,
  ): Promise<{ status: ResourceBookingStatus; ownerId: string; name: string }> {
    const db = (tx ?? this.db) as unknown as Prisma.TransactionClient;
    // Inside the caller's transaction, lock the resource row FIRST: the capacity check and the
    // event write are then atomic — two concurrent bookings of the last free slot can't both
    // pass `active < capacity` (the loser waits here and re-counts the winner's booking).
    if (tx) await tx.$queryRaw`SELECT id FROM resources WHERE id = ${resourceId} FOR UPDATE`;
    const resource = await db.resource.findUnique({ where: { id: resourceId } });
    if (!resource) throw notFound('resource.notFound');
    if (resource.ownerId !== bookerId && !(await this.canBook(resource, bookerId))) {
      throw forbidden('resource.bookingNoAccess');
    }
    const active = await this.countActive(resourceId, start, end, excludeEventId, db);
    if (active >= resource.capacity) {
      throw conflict('resource.busy');
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
      throw badRequest('resource.requestNotPending');
    }
    await this.db.$transaction(async (tx) => {
      // Resource row lock: two parallel confirms of overlapping requests (or a confirm racing a
      // new booking) serialise here — the capacity check and the status flip are atomic.
      await tx.$queryRaw`SELECT id FROM resources WHERE id = ${ev.resourceId!} FOR UPDATE`;
      const confirmed = await tx.calendarEvent.count({
        where: {
          resourceId: ev.resourceId!,
          resourceStatus: 'confirmed',
          id: { not: eventId },
          startTime: { lt: ev.endTime },
          endTime: { gt: ev.startTime },
        },
      });
      if (confirmed >= ev.resource!.capacity) {
        throw conflict('resource.busyConfirmed');
      }
      const claimed = await tx.calendarEvent.updateMany({
        where: { id: eventId, resourceStatus: 'pending' },
        data: { resourceStatus: 'confirmed' },
      });
      if (claimed.count === 0) throw badRequest('resource.requestNotPending');
    });
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

  /**
   * Гейт «между людьми» для списка тех, кому владелец раздаёт право бронировать.
   * Раньше `bookerUserIds`/`bookerCircleIds` писались в строку КАК ЕСТЬ: можно было вписать
   * постороннего человека вне окружения и — хуже — ЧУЖОЙ circleId, после чего участники
   * группы незнакомца получали доступ к брони (Группа резолвится по членству, а не по
   * владельцу). Ресурс — ЛИЧНАЯ вещь, поэтому `personalOnly`: рабочий пропуск здесь не
   * годится (со-членство в организации не должно само по себе выдавать ключ от моей машины).
   */
  private async assertBookersAllowed(
    ownerId: string,
    bookerUserIds?: string[] | null,
    bookerCircleIds?: string[] | null,
  ): Promise<void> {
    if (bookerUserIds?.length) {
      await this.contacts.assertReachable(
        ownerId,
        bookerUserIds,
        'contacts.bookingCircleOnly',
        { personalOnly: true },
      );
    }
    for (const circleId of bookerCircleIds ?? []) {
      // gate:false — состав своей Группы по определению из окружения владельца, здесь важна
      // ТОЛЬКО проверка владения (бросит Forbidden на чужую группу).
      await this.contacts.resolveCircleMemberIds(ownerId, circleId, { gate: false });
    }
  }

  private async loadBookingForOwner(ownerId: string, eventId: string) {
    const ev = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      include: { resource: { select: { ownerId: true, name: true, capacity: true } } },
    });
    if (!ev || !ev.resource) throw notFound('resource.bookingNotFound');
    if (ev.resource.ownerId !== ownerId) throw forbidden('resource.notOwner');
    return ev;
  }

  private async countActive(
    resourceId: string,
    start: Date,
    end: Date,
    excludeEventId?: string,
    db: Prisma.TransactionClient = this.db as unknown as Prisma.TransactionClient,
  ): Promise<number> {
    return db.calendarEvent.count({
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
    const myCircleIds = await this.contacts.listCircleIdsWhereMember(userId);
    return resource.bookerCircleIds.some((c) => myCircleIds.includes(c));
  }

  private async assertOwned(ownerId: string, id: string): Promise<ResourceRow> {
    const r = await this.db.resource.findUnique({ where: { id } });
    if (!r) throw notFound('resource.notFound');
    if (r.ownerId !== ownerId) throw forbidden('resource.notOwner');
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
      title: revealBooker ? e.title : this.i18n.translate('calendar.bookedSlot'),
      start: e.startTime.toISOString(),
      end: e.endTime.toISOString(),
      bookerId: e.userId,
      bookerName: revealBooker ? fullName(e.user) : this.i18n.translate('calendar.bookedSlot'),
      status: (e.resourceStatus as ResourceBookingStatus) ?? 'confirmed',
    };
  }
}
