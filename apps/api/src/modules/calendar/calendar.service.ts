import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { RRule } from 'rrule';
import { CalendarEvent as CalEventRow } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { fullName } from '../../shared/utils/user-name';
import { EventBusService } from '../../shared/events/event-bus.service';
import { TasksService } from '../tasks/tasks.service';
import { ContactsService } from '../contacts/contacts.service';
import { FinancesService } from '../finances/finances.service';
import { ResourcesService } from './resources.service';
import { AccessService } from '../../core/access/access.service';
import { Principal } from '../../core/access/access.types';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import {
  DEFAULT_REMINDER_OFFSETS,
  CALENDAR_LIMITS,
  CALENDAR_ACCESS_LEVEL_META,
  SMART_MATCH_DEFAULTS,
  RSVP_META,
} from '@superapp/shared';
import type {
  CalendarItem,
  CalendarEventOccurrence,
  CalendarTaskItem,
  CalendarEvent as CalendarEventDto,
  CalendarEventDetail,
  CalendarEventVisibility,
  CalendarAccessLevel,
  CalendarLayer,
  CreateCalendarEventRequest,
  UpdateCalendarEventRequest,
  RsvpStatus,
  EventParticipant as EventParticipantDto,
  SmartMatchRequest,
  SmartMatchResponse,
  SmartMatchSlot,
  CalendarShare as CalendarShareDto,
  SharedCalendarSource,
  ResourceBookingStatus,
} from '@superapp/shared';

const MS_PER_DAY = 86_400_000;
type UserMini = { id: string; firstName: string; lastName: string | null; avatar: string | null };
/** Context passed to occurrenceDto describing how the viewer sees this row. */
interface OccCtx {
  ownerName: string | null;
  busy: boolean;
  myRsvp: RsvpStatus | null;
  attendeeCount: number;
  reminderOffsets: number[];
  resourceName: string | null;
}

@Injectable()
export class CalendarService implements OnModuleInit {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private tasks: TasksService,
    private resources: ResourcesService,
    private access: AccessService,
    private quickActions: QuickActionRegistry,
    private contacts: ContactsService,
    private finances: FinancesService,
  ) {}

  onModuleInit(): void {
    // Phase 7: "Событие" in the chat ＋-menu. Form = modal (title/time/participants);
    // result = the event Rich Card posted into the chat.
    this.quickActions.register({
      key: 'event.create',
      label: 'Событие',
      icon: '📅',
      scopes: ['composer'],
      description: 'Создать событие в календаре',
    });
  }

  private user(id: string): Principal {
    return { type: 'user', id };
  }

  // ============================================================
  // Range query — expands recurrence, merges task layer, my participations,
  // and (optionally) overlay calendars of people who shared with me.
  // ============================================================

  async getRange(
    userId: string,
    fromISO: string,
    toISO: string,
    layers?: CalendarLayer[],
    include?: string[],
  ): Promise<{ items: CalendarItem[] }> {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    if (isNaN(+from) || isNaN(+to) || to < from) {
      throw new BadRequestException('Некорректный диапазон дат');
    }
    if ((+to - +from) / MS_PER_DAY > CALENDAR_LIMITS.rangeMaxDays) {
      throw new BadRequestException('Слишком большой диапазон');
    }

    const active: CalendarLayer[] = layers?.length ? layers : ['events', 'tasks'];
    const items: CalendarItem[] = [];

    if (active.includes('events')) {
      // 1) My own events + events where I'm a participant (full detail).
      const participantSelect = {
        select: { userId: true, role: true, rsvp: true, reminderOffsets: true },
      } as const;
      const userSelect = { select: { id: true, firstName: true, lastName: true } } as const;
      const resourceSelect = { select: { name: true } } as const;

      const mineWhere = {
        OR: [{ userId }, { participants: { some: { userId } } }],
      };
      const masters = await this.db.calendarEvent.findMany({
        where: {
          recurrenceParentId: null,
          ...mineWhere,
          AND: [
            {
              OR: [
                // recurring: skip series that ENDED before the range (recurrenceEndsAt is
                // materialized; null = infinite) — otherwise every master ever created is
                // fetched + RRULE-expanded on every calendar view forever.
                {
                  recurrenceRule: { not: null },
                  startTime: { lte: to },
                  OR: [{ recurrenceEndsAt: null }, { recurrenceEndsAt: { gte: from } }],
                },
                { recurrenceRule: null, startTime: { lte: to }, endTime: { gte: from } },
              ],
            },
          ],
        },
        include: { user: userSelect, participants: participantSelect, resource: resourceSelect },
      });
      const overrides = await this.db.calendarEvent.findMany({
        where: {
          recurrenceParentId: { not: null },
          ...mineWhere,
          startTime: { lte: to },
          endTime: { gte: from },
        },
        include: { user: userSelect, participants: participantSelect, resource: resourceSelect },
      });

      for (const ev of [...masters, ...overrides]) {
        const mine = ev.userId === userId;
        const myP = ev.participants.find((p) => p.userId === userId);
        const ctx: OccCtx = {
          ownerName: mine ? null : fullName(ev.user),
          busy: false,
          myRsvp: mine ? null : myP?.rsvp ? (myP.rsvp as RsvpStatus) : null,
          attendeeCount: ev.participants.length,
          reminderOffsets: mine ? ev.reminderOffsets : myP?.reminderOffsets ?? [],
          resourceName: ev.resource?.name ?? null,
        };
        items.push(...this.buildOccurrences(ev, from, to, ctx));
      }

      // 2) Overlay calendars I chose to view (only those who shared with me).
      // Precompute access in TWO reverse walks instead of 2 queries per included calendar
      // (fixes the overlay N+1). detailed_viewer ⊆ busy_viewer, so check detailed first.
      const overlayIds = (include ?? []).filter((id) => id !== userId);
      const detailedSet = overlayIds.length
        ? new Set(await this.access.listObjects(this.user(userId), 'detailed_viewer', 'calendar'))
        : new Set<string>();
      const busySet = overlayIds.length
        ? new Set(await this.access.listObjects(this.user(userId), 'busy_viewer', 'calendar'))
        : new Set<string>();
      for (const ownerId of include ?? []) {
        if (ownerId === userId) continue;
        const level: CalendarAccessLevel = detailedSet.has(ownerId) ? 'detailed' : busySet.has(ownerId) ? 'busy' : 'none';
        if (level === 'none') continue;
        const owner = await this.db.user.findUnique({
          where: { id: ownerId },
          select: { firstName: true, lastName: true },
        });
        if (!owner) continue;
        const ownerName = fullName(owner);
        const levelBusy = level === 'busy';

        const where = {
          userId: ownerId,
          visibility: { not: 'hidden' },
          NOT: { participants: { some: { userId } } }, // dedupe events I'm invited to
        };
        const oMasters = await this.db.calendarEvent.findMany({
          where: {
            ...where,
            recurrenceParentId: null,
            AND: [
              {
                OR: [
                  {
                    recurrenceRule: { not: null },
                    startTime: { lte: to },
                    OR: [{ recurrenceEndsAt: null }, { recurrenceEndsAt: { gte: from } }],
                  },
                  { recurrenceRule: null, startTime: { lte: to }, endTime: { gte: from } },
                ],
              },
            ],
          },
          include: { participants: { select: { userId: true } }, resource: resourceSelect },
        });
        const oOverrides = await this.db.calendarEvent.findMany({
          where: {
            ...where,
            recurrenceParentId: { not: null },
            startTime: { lte: to },
            endTime: { gte: from },
          },
          include: { participants: { select: { userId: true } }, resource: resourceSelect },
        });
        for (const ev of [...oMasters, ...oOverrides]) {
          const busy = levelBusy || ev.visibility === 'busy';
          items.push(
            ...this.buildOccurrences(ev, from, to, {
              ownerName,
              busy,
              myRsvp: null,
              attendeeCount: busy ? 0 : ev.participants.length,
              reminderOffsets: [],
              resourceName: busy ? null : ev.resource?.name ?? null,
            }),
          );
        }
      }
    }

    if (active.includes('tasks')) {
      const tasks = await this.tasks.listForCalendar(userId, from, to);
      for (const t of tasks) items.push(this.taskItemDto(t));
    }

    if (active.includes('finance')) {
      // Финансы — такой же ВИРТУАЛЬНЫЙ слой, как задачи (ничего не копируется):
      // дни платежей по долгам + повторяющиеся операции.
      const payments = await this.finances.getPaymentsForCalendar(userId, from, to);
      items.push(...payments);
    }

    items.sort((a, b) => a.start.localeCompare(b.start));
    return { items };
  }

  // ============================================================
  // CRUD
  // ============================================================

  async createEvent(userId: string, data: CreateCalendarEventRequest): Promise<CalendarEventDto> {
    if (data.recurrenceRule) this.assertValidRule(data.recurrenceRule);
    if (data.recurrenceRule && data.resourceId) {
      throw new BadRequestException('Бронь ресурса доступна только для разовых событий');
    }
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);

    const { event, booking } = await this.db.$transaction(async (tx) => {
      let resourceStatus: ResourceBookingStatus | null = null;
      let bookingInfo: { status: ResourceBookingStatus; ownerId: string; name: string } | null = null;
      if (data.resourceId) {
        // Capacity check + event row in ONE tx under the resource row lock — two concurrent
        // bookings of the last free slot can't both pass.
        bookingInfo = await this.resources.prepareBooking(data.resourceId, userId, start, end, undefined, tx);
        resourceStatus = bookingInfo.status;
      }
      const created = await tx.calendarEvent.create({
        data: {
          userId,
          title: data.title,
          description: data.description ?? null,
          location: data.location ?? null,
          startTime: start,
          endTime: end,
          allDay: data.allDay ?? false,
          color: data.color ?? null,
          visibility: data.visibility ?? 'inherit',
          reminderOffsets: data.reminderOffsets ?? [...DEFAULT_REMINDER_OFFSETS],
          recurrenceRule: data.recurrenceRule ?? null,
          recurrenceEndsAt: this.computeRecurrenceEnd(data.recurrenceRule ?? null, start, +end - +start),
          resourceId: data.resourceId ?? null,
          resourceStatus,
        },
      });
      return { event: created, booking: bookingInfo };
    });
    await this.materializeRemindersFor(event, userId, event.reminderOffsets);

    if (data.participantUserIds?.length || data.participantCircleId) {
      await this.inviteParticipants(userId, event.id, {
        userIds: data.participantUserIds,
        circleId: data.participantCircleId,
      });
    }
    if (booking && booking.status === 'pending') {
      this.resources.emitRequested(booking.ownerId, userId, booking.name, event.title, event.id);
    }
    // Messenger (Phase 3) listens to create the event's context chat eagerly + plaque.
    this.events.emit(
      'calendar.event.created',
      { eventId: event.id, eventTitle: event.title, byUserId: userId },
      'calendar',
    );
    this.events.emit('google.push', { userId, eventId: event.id, op: 'upsert' }, 'calendar');
    return this.toEventDto(event);
  }

  async updateEvent(
    userId: string,
    id: string,
    data: UpdateCalendarEventRequest,
  ): Promise<CalendarEventDto> {
    const row = await this.ownedEvent(userId, id);
    if (data.recurrenceRule) this.assertValidRule(data.recurrenceRule);

    const scope = data.editScope ?? 'all';
    const master = row.recurrenceParentId
      ? await this.ownedEvent(userId, row.recurrenceParentId)
      : row;

    let result: CalEventRow;
    let pendingNotify: { ownerId: string; name: string } | null = null;

    if (scope === 'all' || (!master.recurrenceRule && !row.recurrenceParentId)) {
      const patch = this.patchData(data);
      const newStart = data.startTime ? new Date(data.startTime) : master.startTime;
      const newEnd = data.endTime ? new Date(data.endTime) : master.endTime;

      // Booking validation + the event update run in ONE tx under the resource row lock
      // (same race as createEvent: capacity must be checked atomically with the write).
      // Keep the materialized series end in sync with rule/time changes.
      if (data.recurrenceRule !== undefined || data.startTime !== undefined || data.endTime !== undefined) {
        const rule = data.recurrenceRule !== undefined ? data.recurrenceRule : master.recurrenceRule;
        patch.recurrenceEndsAt = this.computeRecurrenceEnd(rule, newStart, +newEnd - +newStart);
      }

      const txOut = await this.db.$transaction(async (tx) => {
        let pn: { ownerId: string; name: string } | null = null;
        if (data.resourceId !== undefined) {
          // attach / change / detach a resource booking
          if (data.resourceId === null) {
            patch.resourceId = null;
            patch.resourceStatus = null;
          } else {
            if (master.recurrenceRule) {
              throw new BadRequestException('Бронь ресурса доступна только для разовых событий');
            }
            const b = await this.resources.prepareBooking(data.resourceId, userId, newStart, newEnd, master.id, tx);
            patch.resourceId = data.resourceId;
            patch.resourceStatus = b.status;
            if (b.status === 'pending') pn = { ownerId: b.ownerId, name: b.name };
          }
        } else if (master.resourceId && (data.startTime !== undefined || data.endTime !== undefined)) {
          // time changed on an existing booking → re-validate availability (re-pends if not owner)
          const b = await this.resources.prepareBooking(master.resourceId, userId, newStart, newEnd, master.id, tx);
          patch.resourceStatus = b.status;
          if (b.status === 'pending') pn = { ownerId: b.ownerId, name: b.name };
        }

        const updated = await tx.calendarEvent.update({ where: { id: master.id }, data: patch });
        return { updated, pn };
      });
      result = txOut.updated;
      pendingNotify = txOut.pn;
      await this.remassializeAll(result);
    } else {
      if (!data.occurrenceStart) {
        throw new BadRequestException('Нужен occurrenceStart для правки экземпляра');
      }
      const occ = new Date(data.occurrenceStart);
      result =
        scope === 'this'
          ? await this.editSingleOccurrence(master, occ, data)
          : await this.splitSeries(master, occ, data);
    }

    await this.notifyParticipants(master.id, master.title, 'calendar.event.updated', userId);
    if (pendingNotify) {
      this.resources.emitRequested(pendingNotify.ownerId, userId, pendingNotify.name, result.title, result.id);
    }
    this.events.emit('google.push', { userId, eventId: master.id, op: 'upsert' }, 'calendar');
    return this.toEventDto(result);
  }

  async deleteEvent(
    userId: string,
    id: string,
    opts?: { editScope?: 'this' | 'this_and_following' | 'all'; occurrenceStart?: string },
  ): Promise<void> {
    const row = await this.ownedEvent(userId, id);
    const scope = opts?.editScope ?? 'all';
    const master = row.recurrenceParentId
      ? await this.ownedEvent(userId, row.recurrenceParentId)
      : row;

    if (scope === 'all' || (!master.recurrenceRule && !row.recurrenceParentId)) {
      const gid = master.googleEventId;
      await this.notifyParticipants(master.id, master.title, 'calendar.event.cancelled', userId);
      await this.db.calendarEvent.delete({ where: { id: master.id } }); // cascades overrides, reminders, participants
      if (gid) this.events.emit('google.push', { userId, op: 'delete', googleEventId: gid }, 'calendar');
      return;
    }

    if (!opts?.occurrenceStart) {
      throw new BadRequestException('Нужен occurrenceStart для удаления экземпляра');
    }
    const occ = new Date(opts.occurrenceStart);

    if (scope === 'this') {
      await this.excludeOccurrence(master, occ);
    } else {
      const truncatedRule = this.setUntil(master.recurrenceRule!, new Date(+occ - 1000));
      await this.db.calendarEvent.update({
        where: { id: master.id },
        data: {
          recurrenceRule: truncatedRule,
          recurrenceEndsAt: this.computeRecurrenceEnd(truncatedRule, master.startTime, +master.endTime - +master.startTime),
        },
      });
      await this.db.calendarEvent.deleteMany({
        where: { recurrenceParentId: master.id, recurrenceId: { gte: occ } },
      });
      await this.db.calendarEventReminder.deleteMany({
        where: { eventId: master.id, sentAt: null, occurrenceStart: { gte: occ } },
      });
      const fresh = await this.db.calendarEvent.findUnique({ where: { id: master.id } });
      if (fresh) await this.remassializeAll(fresh);
    }
    this.events.emit('google.push', { userId, eventId: master.id, op: 'upsert' }, 'calendar');
  }

  /** Full event detail (for the editor/card): owner & participants only. */
  async getEventDetail(viewerId: string, eventId: string): Promise<CalendarEventDetail> {
    const event = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      include: { participants: true, resource: { select: { name: true, ownerId: true } } },
    });
    if (!event) throw new NotFoundException('Событие не найдено');

    const isOrganizer = event.userId === viewerId;
    const myP = event.participants.find((p) => p.userId === viewerId);
    const isResourceOwner = !!event.resource && event.resource.ownerId === viewerId;
    if (!isOrganizer && !myP && !isResourceOwner) {
      const level = await this.resolveAccessLevel(event.userId, viewerId);
      if (this.accessRank(level) < 2) {
        throw new ForbiddenException('Нет доступа к деталям события');
      }
    }

    const ids = event.participants.map((p) => p.userId);
    const users = ids.length
      ? await this.db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, firstName: true, lastName: true, avatar: true },
        })
      : [];
    const umap = new Map(users.map((u) => [u.id, u]));
    const participants: EventParticipantDto[] = event.participants.map((p) => {
      const u = umap.get(p.userId);
      return {
        userId: p.userId,
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? null,
        avatar: u?.avatar ?? null,
        role: p.role as 'organizer' | 'attendee',
        rsvp: p.rsvp as RsvpStatus,
      };
    });

    return {
      ...this.toEventDto(event),
      reminderOffsets: isOrganizer ? event.reminderOffsets : myP?.reminderOffsets ?? [],
      isOrganizer,
      myRsvp: myP ? (myP.rsvp as RsvpStatus) : null,
      participants,
      resourceName: event.resource?.name ?? null,
      isResourceOwner,
    };
  }

  // ============================================================
  // Participants & RSVP
  // ============================================================

  async inviteParticipants(
    organizerId: string,
    eventId: string,
    input: { userIds?: string[]; circleId?: string },
  ): Promise<string[]> {
    const event = await this.ownedEvent(organizerId, eventId);
    if (event.recurrenceParentId) {
      throw new BadRequestException('Приглашайте на всю серию, а не на отдельный экземпляр');
    }

    let ids: string[] = [];
    if (input.circleId) ids.push(...(await this.resolveCircleMemberIds(organizerId, input.circleId)));
    if (input.userIds) ids.push(...input.userIds);
    ids = [...new Set(ids)].filter((id) => id && id !== organizerId);
    if (!ids.length) return [];

    await this.assertInEnvironment(organizerId, ids);

    const existing = await this.db.eventParticipant.findMany({
      where: { eventId, userId: { in: ids } },
      select: { userId: true },
    });
    const have = new Set(existing.map((e) => e.userId));
    const toAdd = ids.filter((id) => !have.has(id));

    for (const uid of toAdd) {
      await this.db.eventParticipant.create({
        data: {
          eventId,
          userId: uid,
          role: 'attendee',
          rsvp: 'pending',
          reminderOffsets: [...DEFAULT_REMINDER_OFFSETS],
        },
      });
      await this.materializeRemindersFor(event, uid, [...DEFAULT_REMINDER_OFFSETS]);
    }

    if (toAdd.length) {
      this.events.emit(
        'calendar.event.invited',
        { recipientIds: toAdd, eventTitle: event.title, eventId, byUserId: organizerId },
        'calendar',
      );
    }
    return toAdd;
  }

  async rsvp(userId: string, eventId: string, status: RsvpStatus): Promise<void> {
    const p = await this.db.eventParticipant.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
    if (!p) throw new ForbiddenException('Вы не участник события');
    await this.db.eventParticipant.update({
      where: { eventId_userId: { eventId, userId } },
      data: { rsvp: status },
    });
    const event = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      select: { userId: true, title: true },
    });
    if (event) {
      const me = await this.userMini(userId);
      this.events.emit(
        'calendar.event.rsvp',
        {
          recipientIds: [event.userId],
          byUserId: userId,
          byName: fullName(me),
          rsvpLabel: RSVP_META[status]?.label ?? status,
          eventTitle: event.title,
          eventId,
        },
        'calendar',
      );
    }
  }

  /** Organizer removes a participant, or a participant leaves themselves. */
  async removeParticipant(actorId: string, eventId: string, targetUserId: string): Promise<void> {
    const event = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      select: { userId: true, title: true },
    });
    if (!event) throw new NotFoundException('Событие не найдено');
    if (event.userId !== actorId && actorId !== targetUserId) {
      throw new ForbiddenException('Нет прав убрать этого участника');
    }
    await this.db.eventParticipant.deleteMany({ where: { eventId, userId: targetUserId } });
    await this.db.calendarEventReminder.deleteMany({
      where: { eventId, userId: targetUserId, sentAt: null },
    });
    // Messenger (Phase 3): resync event chat membership (Hard Revoke) + plaque.
    this.events.emit(
      'calendar.event.participant_removed',
      { eventId, eventTitle: event.title, byUserId: actorId, removedUserId: targetUserId },
      'calendar',
    );
  }

  /** Set the calling user's own reminders for an event (organizer's or a participant's). */
  async setMyReminders(userId: string, eventId: string, offsets: number[]): Promise<void> {
    const event = await this.db.calendarEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Событие не найдено');
    if (event.userId === userId) {
      await this.db.calendarEvent.update({ where: { id: eventId }, data: { reminderOffsets: offsets } });
    } else {
      const p = await this.db.eventParticipant.findUnique({
        where: { eventId_userId: { eventId, userId } },
      });
      if (!p) throw new ForbiddenException('Вы не участник события');
      await this.db.eventParticipant.update({
        where: { eventId_userId: { eventId, userId } },
        data: { reminderOffsets: offsets },
      });
    }
    await this.materializeRemindersFor(event, userId, offsets);
  }

  // ============================================================
  // Sharing (per-person + per-group resolve)
  // ============================================================

  async setShare(
    ownerId: string,
    sharedWithUserId: string,
    accessLevel: 'busy' | 'detailed',
  ): Promise<void> {
    if (sharedWithUserId === ownerId) throw new BadRequestException('Нельзя поделиться с самим собой');
    await this.assertInEnvironment(ownerId, [sharedWithUserId]);
    // Tuple-native: clear any prior level, then set the chosen one.
    const subject = { resourceType: 'calendar', resourceId: ownerId, subjectType: 'user', subjectId: sharedWithUserId } as const;
    await this.access.revoke({ ...subject, relation: 'busy_viewer' });
    await this.access.revoke({ ...subject, relation: 'detailed_viewer' });
    await this.access.grant({ ...subject, relation: accessLevel === 'detailed' ? 'detailed_viewer' : 'busy_viewer' });
  }

  async removeShare(ownerId: string, sharedWithUserId: string): Promise<void> {
    const subject = { resourceType: 'calendar', resourceId: ownerId, subjectType: 'user', subjectId: sharedWithUserId } as const;
    await this.access.revoke({ ...subject, relation: 'busy_viewer' });
    await this.access.revoke({ ...subject, relation: 'detailed_viewer' });
  }

  /** People I've personally granted access to (manage list) — from the engine's viewer tuples. */
  async listShares(ownerId: string): Promise<CalendarShareDto[]> {
    const tuples = await this.db.relationTuple.findMany({
      where: { resourceType: 'calendar', resourceId: ownerId, relation: { in: ['busy_viewer', 'detailed_viewer'] }, subjectType: 'user' },
      select: { relation: true, subjectId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (tuples.length === 0) return [];
    const users = await this.db.user.findMany({
      where: { id: { in: tuples.map((t) => t.subjectId) } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const umap = new Map(users.map((u) => [u.id, u]));
    return tuples.map((t) => {
      const u = umap.get(t.subjectId);
      return {
        sharedWithUserId: t.subjectId,
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? null,
        avatar: u?.avatar ?? null,
        accessLevel: (t.relation === 'detailed_viewer' ? 'detailed' : 'busy') as 'busy' | 'detailed',
        createdAt: t.createdAt.toISOString(),
      };
    });
  }

  /** People whose calendars I may view — for the overlay layer toggles. Two reverse walks. */
  async listSharedWithMe(viewerId: string): Promise<SharedCalendarSource[]> {
    const detailed = new Set(await this.access.listObjects(this.user(viewerId), 'detailed_viewer', 'calendar'));
    const busy = new Set(await this.access.listObjects(this.user(viewerId), 'busy_viewer', 'calendar'));
    const ownerIds = [...new Set([...detailed, ...busy])].filter((id) => id !== viewerId);
    if (ownerIds.length === 0) return [];
    const users = await this.db.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const out: SharedCalendarSource[] = users.map((u) => ({
      userId: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      avatar: u.avatar,
      accessLevel: detailed.has(u.id) ? 'detailed' : 'busy',
    }));
    return out.sort((a, b) => fullName(a).localeCompare(fullName(b)));
  }

  // ============================================================
  // Smart Match — blind free-slot finder over people who shared >= busy
  // ============================================================

  async smartMatch(userId: string, req: SmartMatchRequest): Promise<SmartMatchResponse> {
    const from = new Date(req.from);
    const to = new Date(req.to);
    if (isNaN(+from) || isNaN(+to) || to <= from) {
      throw new BadRequestException('Некорректный период');
    }
    const dayStart = req.dayStartMin ?? SMART_MATCH_DEFAULTS.dayStartMin;
    const dayEnd = req.dayEndMin ?? SMART_MATCH_DEFAULTS.dayEndMin;
    const step = SMART_MATCH_DEFAULTS.slotStepMin;
    const durMs = req.durationMin * 60_000;

    const allowed: string[] = [];
    for (const uid of [...new Set(req.userIds)]) {
      if (uid === userId) continue;
      const level = await this.resolveAccessLevel(uid, userId);
      if (this.accessRank(level) >= 1) allowed.push(uid);
    }

    const busy = await this.collectBusyIntervals([userId, ...allowed], from, to);

    const slots: SmartMatchSlot[] = [];
    // Walk each UTC day in range; build the working window; subtract busy; emit slots.
    const dayCursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    for (; dayCursor <= to && slots.length < SMART_MATCH_DEFAULTS.maxSlots; dayCursor.setUTCDate(dayCursor.getUTCDate() + 1)) {
      const base = dayCursor.getTime();
      let winStart = base + dayStart * 60_000;
      let winEnd = base + dayEnd * 60_000;
      winStart = Math.max(winStart, from.getTime(), Date.now());
      winEnd = Math.min(winEnd, to.getTime());
      if (winEnd - winStart < durMs) continue;

      // free sub-intervals = window minus busy
      let cursor = winStart;
      const dayBusy = busy
        .filter((b) => b.end > winStart && b.start < winEnd)
        .sort((a, b) => a.start - b.start);
      for (const b of dayBusy) {
        if (b.start > cursor) this.emitSlots(slots, cursor, Math.min(b.start, winEnd), durMs, step, SMART_MATCH_DEFAULTS.maxSlots);
        cursor = Math.max(cursor, b.end);
        if (cursor >= winEnd || slots.length >= SMART_MATCH_DEFAULTS.maxSlots) break;
      }
      if (cursor < winEnd) this.emitSlots(slots, cursor, winEnd, durMs, step, SMART_MATCH_DEFAULTS.maxSlots);
    }
    return { slots };
  }

  private emitSlots(out: SmartMatchSlot[], start: number, end: number, durMs: number, stepMin: number, max: number) {
    const stepMs = stepMin * 60_000;
    for (let s = start; s + durMs <= end && out.length < max; s += stepMs) {
      out.push({ start: new Date(s).toISOString(), end: new Date(s + durMs).toISOString() });
    }
  }

  private async collectBusyIntervals(
    userIds: string[],
    from: Date,
    to: Date,
  ): Promise<Array<{ start: number; end: number }>> {
    const events = await this.db.calendarEvent.findMany({
      where: {
        userId: { in: userIds },
        OR: [
          {
            recurrenceRule: { not: null },
            startTime: { lte: to },
            OR: [{ recurrenceEndsAt: null }, { recurrenceEndsAt: { gte: from } }],
          },
          { recurrenceRule: null, startTime: { lte: to }, endTime: { gte: from } },
        ],
      },
      select: { startTime: true, endTime: true, recurrenceRule: true, exDates: true, id: true, recurrenceParentId: true, recurrenceId: true },
    });
    const out: Array<{ start: number; end: number }> = [];
    for (const ev of events) {
      const durMs = +ev.endTime - +ev.startTime;
      if (ev.recurrenceRule) {
        for (const s of this.expandMaster(ev as unknown as CalEventRow, from, to)) {
          out.push({ start: +s, end: +s + durMs });
        }
      } else {
        out.push({ start: +ev.startTime, end: +ev.endTime });
      }
    }
    return out;
  }

  // ============================================================
  // Contextual presence (Messenger Phase 4)
  // ============================================================

  /**
   * The user's CURRENTLY ongoing event (now ∈ [start, start+duration)), if any.
   * Considers their own events — single rows and recurring masters (expanded via
   * expandMaster) — and returns the one whose live occurrence contains `now`,
   * with its actual end time. Returns null when the user is not in an event.
   * Used by the messenger presence layer to derive a contextual status.
   */
  async getCurrentEvent(userId: string): Promise<{ title: string; endTime: Date } | null> {
    const now = new Date();
    // Bound the recurring scan: any occurrence containing `now` must have started
    // within this lookback (a single occurrence longer than a year is implausible);
    // masters starting in the future can't be live.
    const lookback = new Date(+now - 366 * MS_PER_DAY);

    const events = await this.db.calendarEvent.findMany({
      where: {
        userId,
        OR: [
          // single events overlapping now
          { recurrenceRule: null, startTime: { lte: now }, endTime: { gt: now } },
          // recurring masters that started before now AND whose series hasn't ended yet
          {
            recurrenceRule: { not: null },
            startTime: { lte: now },
            OR: [{ recurrenceEndsAt: null }, { recurrenceEndsAt: { gte: now } }],
          },
        ],
      },
      select: {
        id: true,
        title: true,
        startTime: true,
        endTime: true,
        recurrenceRule: true,
        exDates: true,
        recurrenceParentId: true,
        recurrenceId: true,
      },
    });

    let best: { title: string; endTime: Date } | null = null;
    for (const ev of events) {
      const durMs = +ev.endTime - +ev.startTime;
      if (!ev.recurrenceRule) {
        // single (the WHERE already guarantees overlap)
        if (!best || ev.endTime < best.endTime) best = { title: ev.title, endTime: ev.endTime };
        continue;
      }
      // recurring: find the occurrence whose [start, start+dur) contains now
      const starts = this.expandMaster(ev as unknown as CalEventRow, lookback, now);
      for (const s of starts) {
        const occEnd = new Date(+s + durMs);
        if (+s <= +now && +occEnd > +now) {
          if (!best || occEnd < best.endTime) best = { title: ev.title, endTime: occEnd };
        }
      }
    }
    return best;
  }

  // ============================================================
  // Recurrence-edit internals (Phase 1)
  // ============================================================

  private async editSingleOccurrence(
    master: CalEventRow,
    occ: Date,
    data: UpdateCalendarEventRequest,
  ): Promise<CalEventRow> {
    await this.addExDate(master, occ);
    const existing = await this.db.calendarEvent.findFirst({
      where: { recurrenceParentId: master.id, recurrenceId: occ },
    });
    const durationMs = +master.endTime - +master.startTime;
    const baseStart = data.startTime ? new Date(data.startTime) : occ;
    const baseEnd = data.endTime ? new Date(data.endTime) : new Date(+baseStart + durationMs);

    let override: CalEventRow;
    if (existing) {
      override = await this.db.calendarEvent.update({
        where: { id: existing.id },
        data: this.patchData({ ...data, editScope: undefined }),
      });
    } else {
      override = await this.db.calendarEvent.create({
        data: {
          userId: master.userId,
          title: data.title ?? master.title,
          description: data.description !== undefined ? data.description : master.description,
          location: data.location !== undefined ? data.location : master.location,
          startTime: baseStart,
          endTime: baseEnd,
          allDay: data.allDay ?? master.allDay,
          color: data.color !== undefined ? data.color : master.color,
          visibility: (data.visibility ?? master.visibility) as string,
          reminderOffsets: data.reminderOffsets ?? master.reminderOffsets,
          recurrenceRule: null,
          recurrenceParentId: master.id,
          recurrenceId: occ,
        },
      });
    }
    await this.materializeRemindersFor(override, override.userId, override.reminderOffsets);
    return override;
  }

  private async splitSeries(
    master: CalEventRow,
    occ: Date,
    data: UpdateCalendarEventRequest,
  ): Promise<CalEventRow> {
    const originalRule = master.recurrenceRule!;
    const headRule = this.setUntil(originalRule, new Date(+occ - 1000));
    await this.db.calendarEvent.update({
      where: { id: master.id },
      data: {
        recurrenceRule: headRule,
        recurrenceEndsAt: this.computeRecurrenceEnd(headRule, master.startTime, +master.endTime - +master.startTime),
      },
    });
    const durationMs = +master.endTime - +master.startTime;
    const newStart = data.startTime ? new Date(data.startTime) : occ;
    const newEnd = data.endTime ? new Date(data.endTime) : new Date(+newStart + durationMs);
    const tailRule =
      data.recurrenceRule !== undefined ? data.recurrenceRule : this.stripUntilCount(originalRule);

    const tail = await this.db.calendarEvent.create({
      data: {
        userId: master.userId,
        title: data.title ?? master.title,
        description: data.description !== undefined ? data.description : master.description,
        location: data.location !== undefined ? data.location : master.location,
        startTime: newStart,
        endTime: newEnd,
        allDay: data.allDay ?? master.allDay,
        color: data.color !== undefined ? data.color : master.color,
        visibility: (data.visibility ?? master.visibility) as string,
        reminderOffsets: data.reminderOffsets ?? master.reminderOffsets,
        recurrenceRule: tailRule,
        recurrenceEndsAt: this.computeRecurrenceEnd(tailRule, newStart, +newEnd - +newStart),
      },
    });
    await this.db.calendarEvent.updateMany({
      where: { recurrenceParentId: master.id, recurrenceId: { gte: occ } },
      data: { recurrenceParentId: tail.id },
    });
    const laterEx = master.exDates.filter((d) => d >= occ);
    if (laterEx.length) {
      await this.db.calendarEvent.update({
        where: { id: master.id },
        data: { exDates: master.exDates.filter((d) => d < occ) },
      });
      await this.db.calendarEvent.update({ where: { id: tail.id }, data: { exDates: laterEx } });
    }
    const freshMaster = await this.db.calendarEvent.findUnique({ where: { id: master.id } });
    if (freshMaster) await this.materializeRemindersFor(freshMaster, freshMaster.userId, freshMaster.reminderOffsets);
    await this.materializeRemindersFor(tail, tail.userId, tail.reminderOffsets);
    return tail;
  }

  private async excludeOccurrence(master: CalEventRow, occ: Date): Promise<void> {
    await this.addExDate(master, occ);
    await this.db.calendarEvent.deleteMany({
      where: { recurrenceParentId: master.id, recurrenceId: occ },
    });
    await this.db.calendarEventReminder.deleteMany({
      where: { eventId: master.id, occurrenceStart: occ, sentAt: null },
    });
  }

  private async addExDate(master: CalEventRow, occ: Date): Promise<void> {
    if (master.exDates.some((d) => +d === +occ)) return;
    await this.db.calendarEvent.update({
      where: { id: master.id },
      data: { exDates: { push: occ } },
    });
    master.exDates.push(occ);
  }

  // ============================================================
  // Reminders
  // ============================================================

  /** Rebuild unsent reminder rows for ONE user on an event over the rolling horizon. */
  private async materializeRemindersFor(
    event: CalEventRow,
    userId: string,
    offsets: number[],
  ): Promise<void> {
    await this.db.calendarEventReminder.deleteMany({
      where: { eventId: event.id, userId, sentAt: null },
    });
    if (!offsets.length) return;
    const now = new Date();
    const horizonEnd = new Date(+now + CALENDAR_LIMITS.reminderHorizonDays * MS_PER_DAY);
    const starts = event.recurrenceRule ? this.expandMaster(event, now, horizonEnd) : [event.startTime];

    const rows: Array<{
      eventId: string;
      userId: string;
      occurrenceStart: Date;
      minutesBefore: number;
      fireAt: Date;
    }> = [];
    for (const occStart of starts) {
      for (const off of offsets) {
        const fireAt = new Date(+occStart - off * 60_000);
        if (fireAt <= now) continue;
        rows.push({ eventId: event.id, userId, occurrenceStart: occStart, minutesBefore: off, fireAt });
      }
    }
    if (rows.length) {
      await this.db.calendarEventReminder.createMany({ data: rows, skipDuplicates: true });
    }
  }

  /** Re-materialize the owner's + every participant's reminders (after a time/recurrence change). */
  private async remassializeAll(event: CalEventRow): Promise<void> {
    await this.materializeRemindersFor(event, event.userId, event.reminderOffsets);
    const ps = await this.db.eventParticipant.findMany({ where: { eventId: event.id } });
    for (const p of ps) await this.materializeRemindersFor(event, p.userId, p.reminderOffsets);
  }

  async dispatchReminders(): Promise<number> {
    const now = new Date();
    const graceStart = new Date(+now - 2 * 3600 * 1000);
    const due = await this.db.calendarEventReminder.findMany({
      where: { sentAt: null, fireAt: { lte: now, gte: graceStart } },
      include: { event: { select: { id: true, title: true } } },
      orderBy: { fireAt: 'asc' },
      take: 500,
    });
    for (const r of due) {
      this.events.emit(
        'calendar.event.reminder',
        {
          userId: r.userId,
          eventTitle: r.event.title,
          eventId: r.eventId,
          occurrenceStart: r.occurrenceStart.toISOString(),
        },
        'calendar',
      );
    }
    if (due.length) {
      await this.db.calendarEventReminder.updateMany({
        where: { id: { in: due.map((d) => d.id) } },
        data: { sentAt: now },
      });
    }
    return due.length;
  }

  async topUpReminders(): Promise<number> {
    const recurring = await this.db.calendarEvent.findMany({
      // Only series that can still produce future occurrences — finished series
      // (recurrenceEndsAt in the past) have nothing left to materialize.
      where: {
        recurrenceRule: { not: null },
        OR: [{ recurrenceEndsAt: null }, { recurrenceEndsAt: { gte: new Date() } }],
      },
      take: 5000,
    });
    for (const e of recurring) await this.remassializeAll(e);
    return recurring.length;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async ownedEvent(userId: string, id: string): Promise<CalEventRow> {
    const event = await this.db.calendarEvent.findUnique({ where: { id } });
    if (!event) throw new NotFoundException('Событие не найдено');
    if (event.userId !== userId) throw new ForbiddenException('Нет доступа к этому событию');
    return event;
  }

  private accessRank(level: string): number {
    return CALENDAR_ACCESS_LEVEL_META[level as CalendarAccessLevel]?.rank ?? 0;
  }

  /** Effective calendar access of `viewerId` to `ownerId`'s calendar (group + personal, MAX). */
  private async resolveAccessLevel(ownerId: string, viewerId: string): Promise<CalendarAccessLevel> {
    if (ownerId === viewerId) return 'detailed';
    // MAX over personal + per-Group shares is inherent in the engine (detailed_viewer ⊇ busy_viewer).
    const lvl = await this.access.resolveLevel(this.user(viewerId), { type: 'calendar', id: ownerId });
    return lvl === 'detailed_viewer' ? 'detailed' : lvl === 'busy_viewer' ? 'busy' : 'none';
  }

  /** Throw unless every id is a confirmed contact AND not blocked (shared gate in Contacts). */
  private async assertInEnvironment(ownerId: string, ids: string[]): Promise<void> {
    await this.contacts.assertReachable(ownerId, ids, 'Приглашать можно только людей из вашего окружения');
  }

  private async resolveCircleMemberIds(ownerId: string, circleId: string): Promise<string[]> {
    const circle = await this.db.circle.findUnique({
      where: { id: circleId },
      include: { memberships: { include: { contactLink: { select: { userAId: true, userBId: true } } } } },
    });
    if (!circle || circle.ownerId !== ownerId) throw new ForbiddenException('Группа не найдена');
    return [
      ...new Set(
        circle.memberships.map((m) =>
          m.contactLink.userAId === ownerId ? m.contactLink.userBId : m.contactLink.userAId,
        ),
      ),
    ];
  }

  private async userMini(id: string): Promise<UserMini> {
    const u = await this.db.user.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return u ?? { id, firstName: '', lastName: null, avatar: null };
  }

  private async notifyParticipants(
    eventId: string,
    eventTitle: string,
    type: 'calendar.event.updated' | 'calendar.event.cancelled',
    byUserId: string,
  ): Promise<void> {
    const ps = await this.db.eventParticipant.findMany({
      where: { eventId },
      select: { userId: true },
    });
    const recipientIds = ps.map((p) => p.userId);
    if (recipientIds.length) {
      this.events.emit(type, { recipientIds, eventTitle, eventId, byUserId }, 'calendar');
    }
  }

  private patchData(data: UpdateCalendarEventRequest) {
    const d: Record<string, unknown> = {};
    if (data.title !== undefined) d.title = data.title;
    if (data.description !== undefined) d.description = data.description;
    if (data.location !== undefined) d.location = data.location;
    if (data.startTime !== undefined) d.startTime = new Date(data.startTime);
    if (data.endTime !== undefined) d.endTime = new Date(data.endTime);
    if (data.allDay !== undefined) d.allDay = data.allDay;
    if (data.color !== undefined) d.color = data.color;
    if (data.visibility !== undefined) d.visibility = data.visibility;
    if (data.reminderOffsets !== undefined) d.reminderOffsets = data.reminderOffsets;
    if (data.recurrenceRule !== undefined) d.recurrenceRule = data.recurrenceRule;
    return d;
  }

  /**
   * Materialized end of a recurrence: last occurrence start (UNTIL/COUNT-bounded) plus the
   * event duration; null = infinite series. Stored on the master (recurrenceEndsAt) so range
   * queries can skip long-finished series without parsing the RRULE.
   */
  private computeRecurrenceEnd(rule: string | null | undefined, dtstart: Date, durationMs: number): Date | null {
    if (!rule) return null;
    try {
      const opts = RRule.parseString(rule);
      if (!opts.until && !opts.count) return null; // infinite
      const r = new RRule({ ...opts, dtstart });
      const all = r.all();
      const last = all.length ? all[all.length - 1] : dtstart;
      return new Date(+last + durationMs);
    } catch {
      return null; // unparseable → treat as infinite (never hides events)
    }
  }

  private expandMaster(event: CalEventRow, from: Date, to: Date): Date[] {
    if (!event.recurrenceRule) return [];
    let rule: RRule;
    try {
      const opts = RRule.parseString(event.recurrenceRule);
      opts.dtstart = event.startTime;
      rule = new RRule(opts);
    } catch {
      return [];
    }
    const ex = new Set(event.exDates.map((d) => +d));
    return rule
      .between(from, to, true)
      .filter((d) => !ex.has(+d))
      .slice(0, CALENDAR_LIMITS.maxOccurrencesPerEvent);
  }

  private buildOccurrences(
    event: CalEventRow & { user?: unknown; participants?: unknown },
    from: Date,
    to: Date,
    ctx: OccCtx,
  ): CalendarEventOccurrence[] {
    let starts: Array<{ start: Date; occ: Date; recurring: boolean; series: string | null }>;
    if (event.recurrenceParentId) {
      starts = [{ start: event.startTime, occ: event.recurrenceId ?? event.startTime, recurring: true, series: event.recurrenceParentId }];
    } else if (event.recurrenceRule) {
      starts = this.expandMaster(event, from, to).map((s) => ({ start: s, occ: s, recurring: true, series: event.id }));
    } else {
      starts = [{ start: event.startTime, occ: event.startTime, recurring: false, series: null }];
    }
    return starts.map((s) => this.occurrenceDto(event, s.start, s.recurring, s.occ, s.series, ctx));
  }

  private occurrenceDto(
    event: CalEventRow,
    start: Date,
    recurring: boolean,
    occurrenceStart: Date,
    seriesId: string | null,
    ctx: OccCtx,
  ): CalendarEventOccurrence {
    const durationMs = +event.endTime - +event.startTime;
    const end = new Date(+start + durationMs);
    return {
      kind: 'event',
      eventId: event.id,
      seriesId: recurring ? seriesId : null,
      occurrenceStart: occurrenceStart.toISOString(),
      recurring,
      title: ctx.busy ? 'Занят' : event.title,
      description: ctx.busy ? null : event.description,
      location: ctx.busy ? null : event.location,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: event.allDay,
      color: ctx.busy ? '#9ca3af' : event.color,
      visibility: event.visibility as CalendarEventVisibility,
      reminderOffsets: ctx.reminderOffsets,
      recurrenceRule: event.recurrenceRule,
      ownerId: event.userId,
      ownerName: ctx.ownerName,
      busy: ctx.busy,
      myRsvp: ctx.myRsvp,
      attendeeCount: ctx.attendeeCount,
      resourceId: event.resourceId,
      resourceName: ctx.busy ? null : ctx.resourceName,
      resourceStatus: event.resourceStatus as ResourceBookingStatus | null,
    };
  }

  private taskItemDto(t: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: Date;
    allDay: boolean;
    overdue: boolean;
    role: string | null;
    coinReward: number | null;
  }): CalendarTaskItem {
    const iso = t.dueDate.toISOString();
    return {
      kind: 'task',
      taskId: t.id,
      title: t.title,
      status: t.status as CalendarTaskItem['status'],
      priority: t.priority as CalendarTaskItem['priority'],
      start: iso,
      end: iso,
      allDay: t.allDay,
      dueDate: iso,
      overdue: t.overdue,
      myRole: t.role as CalendarTaskItem['myRole'],
      coinReward: t.coinReward,
    };
  }

  private toEventDto(e: CalEventRow): CalendarEventDto {
    return {
      id: e.id,
      userId: e.userId,
      title: e.title,
      description: e.description,
      location: e.location,
      startTime: e.startTime.toISOString(),
      endTime: e.endTime.toISOString(),
      allDay: e.allDay,
      color: e.color,
      visibility: e.visibility as CalendarEventVisibility,
      reminderOffsets: e.reminderOffsets,
      recurrenceRule: e.recurrenceRule,
      recurrenceParentId: e.recurrenceParentId,
      recurrenceId: e.recurrenceId ? e.recurrenceId.toISOString() : null,
      resourceId: e.resourceId,
      resourceStatus: e.resourceStatus as ResourceBookingStatus | null,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }

  private assertValidRule(rule: string): void {
    try {
      const opts = RRule.parseString(rule);
      new RRule({ ...opts, dtstart: new Date() });
    } catch {
      throw new BadRequestException('Недопустимое правило повторения');
    }
  }

  private setUntil(rule: string, until: Date): string {
    const stamp = until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return [...this.ruleParts(rule), `UNTIL=${stamp}`].join(';');
  }

  private stripUntilCount(rule: string): string {
    return this.ruleParts(rule).join(';');
  }

  private ruleParts(rule: string): string[] {
    return rule
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter((p) => p && !/^UNTIL=/i.test(p) && !/^COUNT=/i.test(p));
  }
}
