import { Injectable, OnModuleInit } from '@nestjs/common';
import type { RichCardAction, RichCardField, RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { I18nService } from '../../shared/i18n/i18n.service';
import { CalendarService } from './calendar.service';

/** RSVP → ключ каталога. Реестр называет смысл, каталог даёт слово. */
const RSVP_KEYS: Record<string, string> = {
  pending: 'richCards.event.rsvp.pending',
  accepted: 'richCards.event.rsvp.accepted',
  declined: 'richCards.event.rsvp.declined',
  tentative: 'richCards.event.rsvp.tentative',
};

/**
 * Registers the 'event' rich-card renderer + RSVP action handlers. The RSVP buttons show
 * only to an attendee (the organizer doesn't RSVP to their own event). Actions delegate to
 * CalendarService.rsvp, which re-checks participation.
 *
 * ЭТАЛОН переезда провайдера рич-карт на каталог (остальные — по сервису за
 * сессию). Правило простое: ни одной строки для человека в файле — только ключи;
 * даты и время — через `i18n.format(locale)`, а не `toLocaleString('ru-RU')`,
 * иначе карточка навсегда останется русской с российскими форматами.
 */
@Injectable()
export class CalendarRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly calendar: CalendarService,
    private readonly i18n: I18nService,
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

  /** Дата и время в правилах региона зрителя (пояс продукта — см. I18nService.format). */
  private range(start: Date, end: Date, allDay: boolean): string {
    const fmt = this.i18n.format();
    return allDay ? fmt.date(start) : fmt.timeRange(start, end);
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

    const t = (key: string) => this.i18n.translate(key);
    const isOrganizer = event.userId === viewerId;
    const myRsvp = event.participants[0]?.rsvp ?? 'pending';
    const rsvpLabel = t(RSVP_KEYS[myRsvp] ?? RSVP_KEYS.pending);
    const statusLabel = isOrganizer ? t('richCards.event.organizer') : rsvpLabel;
    const when = this.range(event.startTime, event.endTime, event.allDay);

    const fields: RichCardField[] = [{ label: t('richCards.event.when'), value: when }];
    if (event.location) fields.push({ label: t('richCards.event.where'), value: event.location });
    fields.push({ label: t('richCards.event.yourStatus'), value: statusLabel });

    const actions: RichCardAction[] = [];
    // Only an attendee RSVPs (the organizer doesn't answer their own invite).
    if (!isOrganizer && event.participants.length > 0) {
      actions.push({ key: 'event.rsvp_accept', label: t('richCards.event.rsvp.accepted'), style: 'primary' });
      actions.push({ key: 'event.rsvp_tentative', label: t('richCards.event.rsvp.tentative'), style: 'default' });
      actions.push({ key: 'event.rsvp_decline', label: t('richCards.event.rsvp.declined'), style: 'danger' });
    }

    return {
      kind: 'rich_card',
      cardType: 'event',
      ref: { type: 'event', id: refId },
      title: event.title,
      subtitle: when,
      icon: '📅',
      imageUrl: null,
      fields,
      progress: null,
      status: statusLabel,
      actions,
      href: '/calendar',
    };
  }
}
