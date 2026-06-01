import { Injectable, OnModuleInit } from '@nestjs/common';
import type { RichCardAction, RichCardField, RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { CalendarService } from './calendar.service';

const RSVP_WORDS: Record<string, string> = {
  pending: 'Не ответил(а)',
  accepted: 'Иду',
  declined: 'Не иду',
  tentative: 'Возможно',
};

function fmtRange(start: Date, end: Date, allDay: boolean): string {
  if (allDay) return start.toLocaleDateString('ru-RU');
  const d = start.toLocaleDateString('ru-RU');
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return `${d}, ${start.toLocaleTimeString('ru-RU', opts)}–${end.toLocaleTimeString('ru-RU', opts)}`;
}

/**
 * Registers the 'event' rich-card renderer + RSVP action handlers. The RSVP buttons show
 * only to an attendee (the organizer doesn't RSVP to their own event). Actions delegate to
 * CalendarService.rsvp, which re-checks participation.
 */
@Injectable()
export class CalendarRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly calendar: CalendarService,
  ) {}

  onModuleInit() {
    this.registry.registerRenderer('event', (deps, viewerId, refId) => this.renderEvent(deps, viewerId, refId));

    this.registry.registerAction('event.rsvp_accept', {
      requiredCapability: 'event.view',
      handler: (userId, refId) => this.calendar.rsvp(userId, refId, 'accepted'),
    });
    this.registry.registerAction('event.rsvp_decline', {
      requiredCapability: 'event.view',
      handler: (userId, refId) => this.calendar.rsvp(userId, refId, 'declined'),
    });
    this.registry.registerAction('event.rsvp_tentative', {
      requiredCapability: 'event.view',
      handler: (userId, refId) => this.calendar.rsvp(userId, refId, 'tentative'),
    });
  }

  private async renderEvent(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
  ): Promise<RichCardPayload | null> {
    if (!(await deps.access.can({ type: 'user', id: viewerId }, 'event.view', refId))) return null;
    const event = await deps.db.calendarEvent.findUnique({
      where: { id: refId },
      select: {
        title: true,
        location: true,
        startTime: true,
        endTime: true,
        allDay: true,
        userId: true,
        participants: { where: { userId: viewerId }, select: { rsvp: true } },
      },
    });
    if (!event) return null;

    const isOrganizer = event.userId === viewerId;
    const myRsvp = event.participants[0]?.rsvp ?? null;

    const fields: RichCardField[] = [
      { label: 'Когда', value: fmtRange(event.startTime, event.endTime, event.allDay) },
    ];
    if (event.location) fields.push({ label: 'Где', value: event.location });
    fields.push({
      label: 'Ваш статус',
      value: isOrganizer ? 'Организатор' : RSVP_WORDS[myRsvp ?? 'pending'] ?? 'Не ответил(а)',
    });

    const actions: RichCardAction[] = [];
    // Only an attendee RSVPs (the organizer doesn't answer their own invite).
    if (!isOrganizer && event.participants.length > 0) {
      actions.push({ key: 'event.rsvp_accept', label: 'Иду', style: 'primary' });
      actions.push({ key: 'event.rsvp_tentative', label: 'Возможно', style: 'default' });
      actions.push({ key: 'event.rsvp_decline', label: 'Не иду', style: 'danger' });
    }

    return {
      kind: 'rich_card',
      cardType: 'event',
      ref: { type: 'event', id: refId },
      title: event.title,
      subtitle: fmtRange(event.startTime, event.endTime, event.allDay),
      icon: '📅',
      imageUrl: null,
      fields,
      progress: null,
      status: isOrganizer ? 'Организатор' : RSVP_WORDS[myRsvp ?? 'pending'] ?? null,
      actions,
      href: '/calendar',
    };
  }
}
