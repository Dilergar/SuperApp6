import { Injectable, OnModuleInit } from '@nestjs/common';
import { CALENDAR_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
import { CalendarService } from './calendar.service';

/**
 * Календарь в движке сроков core/lifecycle: `calendar.trash` (политика `CalendarEvent`) —
 * корзина `CALENDAR_LIMITS.trashRetentionDays`: мастер-событие уходит навсегда (исключения,
 * напоминания, участники — каскадом FK; копия в Google снята ещё при скрытии).
 * `calendar.subject` — стирание человека: его события и личные ресурсы.
 */
@Injectable()
export class CalendarLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly calendar: CalendarService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.handlers.register('calendar.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.calendar.purgeTrashBatch({ before: this.cutoff(), limit, cursor, releasable }),
      estimate: () => this.calendar.countTrashDue(this.cutoff()),
    });
    this.subjectHooks.register('calendar.subject', {
      erase: (userId, ctx) =>
        this.calendar.erasePersonalCalendar(userId, { deadline: ctx.deadline, held: (n) => ctx.held(n), releasable: (tx, ids) => ctx.releasable(tx, 'CalendarEvent', ids) }),
    });
    this.canary.register('calendar.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: событие человека (сосед — участник) — исчезает с участниками; событие
   * соседа остаётся, но участие и напоминание человека в нём — исчезают; личный ресурс
   * человека — исчезает, ресурс в организации — остаётся ей. Время — через сутки, без
   * повторов: кроны напоминаний до конца прогона его не коснутся.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    const his = await this.db.calendarEvent.create({
      data: { userId: ctx.userId, title: ctx.marker, description: ctx.marker, startTime: start, endTime: end, participants: { create: [{ userId: ctx.peerId }] } },
      select: { id: true, participants: { select: { id: true } } },
    });
    const peers = await this.db.calendarEvent.create({
      data: { userId: ctx.peerId, title: 'canary peer', startTime: start, endTime: end, participants: { create: [{ userId: ctx.userId }] } },
      select: { id: true, participants: { select: { id: true } } },
    });
    const reminder = await this.db.calendarEventReminder.create({
      data: { eventId: peers.id, userId: ctx.userId, occurrenceStart: start, minutesBefore: 15, fireAt: new Date(start.getTime() - 15 * 60_000) },
      select: { id: true },
    });
    const personal = await this.db.resource.create({ data: { ownerId: ctx.userId, name: ctx.marker }, select: { id: true } });
    const orgRes = await this.db.resource.create({ data: { ownerId: ctx.userId, workspaceId: ctx.workspaceId, name: ctx.marker }, select: { id: true } });
    return [
      { policy: 'CalendarEvent', id: his.id, expect: 'gone' },
      ...his.participants.map((p) => ({ policy: 'EventParticipant', id: p.id, expect: 'gone' as const })),
      { policy: 'CalendarEvent', id: peers.id, expect: 'kept' },
      ...peers.participants.map((p) => ({ policy: 'EventParticipant', id: p.id, expect: 'gone' as const })),
      { policy: 'CalendarEventReminder', id: reminder.id, expect: 'gone' },
      { policy: 'Resource', id: personal.id, expect: 'gone' },
      { policy: 'Resource', id: orgRes.id, expect: 'kept', tenant: true },
    ];
  }

  private cutoff(): Date {
    return new Date(Date.now() - CALENDAR_LIMITS.trashRetentionDays * 86_400_000);
  }
}
