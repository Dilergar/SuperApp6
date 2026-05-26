import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { RRule } from 'rrule';
import { CalendarEvent as CalEventRow } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { TasksService } from '../tasks/tasks.service';
import { ResourcesService } from './resources.service';
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
const fullName = (u: { firstName: string; lastName: string | null }) =>
  `${u.firstName} ${u.lastName ?? ''}`.trim();

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
export class CalendarService {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private tasks: TasksService,
    private resources: ResourcesService,
  ) {}

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
                { recurrenceRule: { not: null }, startTime: { lte: to } },
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
      for (const ownerId of include ?? []) {
        if (ownerId === userId) continue;
        const level = await this.resolveAccessLevel(ownerId, userId);
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
                  { recurrenceRule: { not: null }, startTime: { lte: to } },
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

    let resourceStatus: ResourceBookingStatus | null = null;
    let booking: { status: ResourceBookingStatus; ownerId: string; name: string } | null = null;
    if (data.resourceId) {
      booking = await this.resources.prepareBooking(data.resourceId, userId, start, end);
      resourceStatus = booking.status;
    }

    const event = await this.db.calendarEvent.create({
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
        resourceId: data.resourceId ?? null,
        resourceStatus,
      },
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

      if (data.resourceId !== undefined) {
        // attach / change / detach a resource booking
        if (data.resourceId === null) {
          patch.resourceId = null;
          patch.resourceStatus = null;
        } else {
          if (master.recurrenceRule) {
            throw new BadRequestException('Бронь ресурса доступна только для разовых событий');
          }
          const b = await this.resources.prepareBooking(data.resourceId, userId, newStart, newEnd, master.id);
          patch.resourceId = data.resourceId;
          patch.resourceStatus = b.status;
          if (b.status === 'pending') pendingNotify = { ownerId: b.ownerId, name: b.name };
        }
      } else if (master.resourceId && (data.startTime !== undefined || data.endTime !== undefined)) {
        // time changed on an existing booking → re-validate availability (re-pends if not owner)
        const b = await this.resources.prepareBooking(master.resourceId, userId, newStart, newEnd, master.id);
        patch.resourceStatus = b.status;
        if (b.status === 'pending') pendingNotify = { ownerId: b.ownerId, name: b.name };
      }

      result = await this.db.calendarEvent.update({ where: { id: master.id }, data: patch });
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
      await this.db.calendarEvent.update({
        where: { id: master.id },
        data: { recurrenceRule: this.setUntil(master.recurrenceRule!, new Date(+occ - 1000)) },
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
      select: { userId: true },
    });
    if (!event) throw new NotFoundException('Событие не найдено');
    if (event.userId !== actorId && actorId !== targetUserId) {
      throw new ForbiddenException('Нет прав убрать этого участника');
    }
    await this.db.eventParticipant.deleteMany({ where: { eventId, userId: targetUserId } });
    await this.db.calendarEventReminder.deleteMany({
      where: { eventId, userId: targetUserId, sentAt: null },
    });
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
    await this.db.calendarShare.upsert({
      where: { calendarOwnerId_sharedWithUserId: { calendarOwnerId: ownerId, sharedWithUserId } },
      create: { calendarOwnerId: ownerId, sharedWithUserId, accessLevel },
      update: { accessLevel },
    });
  }

  async removeShare(ownerId: string, sharedWithUserId: string): Promise<void> {
    await this.db.calendarShare.deleteMany({
      where: { calendarOwnerId: ownerId, sharedWithUserId },
    });
  }

  /** People I've personally granted access to (manage list). */
  async listShares(ownerId: string): Promise<CalendarShareDto[]> {
    const shares = await this.db.calendarShare.findMany({
      where: { calendarOwnerId: ownerId },
      include: { sharedWith: { select: { firstName: true, lastName: true, avatar: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return shares.map((s) => ({
      sharedWithUserId: s.sharedWithUserId,
      firstName: s.sharedWith.firstName,
      lastName: s.sharedWith.lastName,
      avatar: s.sharedWith.avatar,
      accessLevel: s.accessLevel as 'busy' | 'detailed',
      createdAt: s.createdAt.toISOString(),
    }));
  }

  /** People whose calendars I may view — for the overlay layer toggles. */
  async listSharedWithMe(viewerId: string): Promise<SharedCalendarSource[]> {
    const best = new Map<string, number>(); // ownerId -> rank
    const names = new Map<string, UserMini>();

    const personal = await this.db.calendarShare.findMany({
      where: { sharedWithUserId: viewerId },
      include: { owner: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    });
    for (const s of personal) {
      best.set(s.calendarOwnerId, Math.max(best.get(s.calendarOwnerId) ?? 0, this.accessRank(s.accessLevel)));
      names.set(s.calendarOwnerId, s.owner);
    }

    const links = await this.db.contactLink.findMany({
      where: { OR: [{ userAId: viewerId }, { userBId: viewerId }] },
      include: {
        userA: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        userB: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        memberships: { include: { circle: { select: { ownerId: true, calendarVisibility: true } } } },
      },
    });
    for (const link of links) {
      const other = link.userAId === viewerId ? link.userB : link.userA;
      for (const m of link.memberships) {
        if (m.circle.ownerId !== other.id) continue;
        const rank = this.accessRank(m.circle.calendarVisibility);
        if (rank === 0) continue;
        best.set(other.id, Math.max(best.get(other.id) ?? 0, rank));
        if (!names.has(other.id)) names.set(other.id, other);
      }
    }

    const out: SharedCalendarSource[] = [];
    for (const [ownerId, rank] of best) {
      if (rank === 0) continue;
      const u = names.get(ownerId);
      if (!u) continue;
      out.push({
        userId: ownerId,
        firstName: u.firstName,
        lastName: u.lastName,
        avatar: u.avatar,
        accessLevel: rank >= 2 ? 'detailed' : 'busy',
      });
    }
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
          { recurrenceRule: { not: null }, startTime: { lte: to } },
          { recurrenceRule: null, startTime: { lte: to }, endTime: { gte: from } },
        ],
      },
    });
    const out: Array<{ start: number; end: number }> = [];
    for (const ev of events) {
      const durMs = +ev.endTime - +ev.startTime;
      if (ev.recurrenceRule) {
        for (const s of this.expandMaster(ev, from, to)) {
          out.push({ start: +s, end: +s + durMs });
        }
      } else {
        out.push({ start: +ev.startTime, end: +ev.endTime });
      }
    }
    return out;
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
    await this.db.calendarEvent.update({
      where: { id: master.id },
      data: { recurrenceRule: this.setUntil(originalRule, new Date(+occ - 1000)) },
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
      where: { recurrenceRule: { not: null } },
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
    let rank = 0;
    const share = await this.db.calendarShare.findUnique({
      where: { calendarOwnerId_sharedWithUserId: { calendarOwnerId: ownerId, sharedWithUserId: viewerId } },
    });
    if (share) rank = Math.max(rank, this.accessRank(share.accessLevel));

    const [a, b] = ownerId < viewerId ? [ownerId, viewerId] : [viewerId, ownerId];
    const link = await this.db.contactLink.findUnique({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      include: { memberships: { include: { circle: { select: { ownerId: true, calendarVisibility: true } } } } },
    });
    if (link) {
      for (const m of link.memberships) {
        if (m.circle.ownerId === ownerId) rank = Math.max(rank, this.accessRank(m.circle.calendarVisibility));
      }
    }
    return rank >= 2 ? 'detailed' : rank === 1 ? 'busy' : 'none';
  }

  /** Throw unless every id is a confirmed contact of ownerId. */
  private async assertInEnvironment(ownerId: string, ids: string[]): Promise<void> {
    const others = [...new Set(ids)].filter((id) => id && id !== ownerId);
    if (!others.length) return;
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
    const missing = others.filter((id) => !linked.has(id));
    if (missing.length) {
      throw new ForbiddenException('Приглашать можно только людей из вашего окружения');
    }
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
