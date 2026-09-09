import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { DatabaseService } from '../../shared/database/database.service';
import { SOURCE_LOCALE } from '@superapp/shared';
import { I18nService } from '../../shared/i18n/i18n.service';
import { MessengerService } from './messenger.service';

/**
 * Bridges calendar event-lifecycle events onto the event's CONTEXT chat as system plaques.
 * Best-effort — a failure here never affects the calendar operation.
 *
 *  - On EVERY calendar.event.* event: resync the event's access tuples (idempotent).
 *  - calendar.event.created: create the chat eagerly + plaque "<organizer> создал(а) событие".
 *  - calendar.event.invited: ensure chat + sync members + plaque "<byName> пригласил(а) участников".
 *  - calendar.event.participant_removed: sync members + plaque "<name> покинул(а)/убран(а)".
 *  - calendar.event.updated: plaque "Событие обновлено" ONLY if a chat already exists.
 *  - calendar.event.cancelled: delete the event chat.
 *
 * Lives in the messenger module (depends only on EventBus + AccessProjection + DB + Messenger).
 */
@Injectable()
export class CalendarSystemListener implements OnModuleInit {
  private readonly logger = new Logger(CalendarSystemListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly projection: AccessProjectionService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
    private readonly i18n: I18nService,
  ) {}

  /** Снимок плашки в языке источника (перерисовывается при чтении). */
  private src(key: string, params?: Record<string, string>): string {
    return this.i18n.translateFor(SOURCE_LOCALE, key, params);
  }

  onModuleInit() {
    this.events.onPattern('calendar.event.*').subscribe((e) => {
      void this.handle(e.type, (e.payload ?? {}) as CalendarEventPayload);
    });
  }

  private async handle(type: string, p: CalendarEventPayload): Promise<void> {
    try {
      const eventId = p.eventId;
      if (!eventId) return;

      // cancellation deletes the chat outright (and its tuples) — handle first, no resync.
      if (type === 'calendar.event.cancelled') {
        await this.messenger.deleteEventChat(eventId);
        return;
      }

      await this.projection.resyncEventRoles(eventId);

      if (type === 'calendar.event.created') {
        const who = (p.byName ?? (await this.nameOf(p.byUserId)))?.trim() || this.src('messenger.somebody');
        await this.messenger.postEventSystemMessage(
          eventId,
          type,
          this.src('chatter.type.calendar.event_created', { actorName: who }),
        );
        return;
      }

      if (type === 'calendar.event.invited') {
        const who = (p.byName ?? (await this.nameOf(p.byUserId)))?.trim() || this.src('messenger.somebody');
        await this.messenger.syncEventChatMembers(eventId);
        await this.messenger.postEventSystemMessage(
          eventId,
          type,
          this.src('chatter.type.calendar.event_invited', { actorName: who }),
        );
        return;
      }

      if (type === 'calendar.event.participant_removed') {
        const name = (await this.nameOf(p.removedUserId))?.trim() || this.src('messenger.participantFallback');
        await this.messenger.syncEventChatMembers(eventId);
        // Plaque only if a chat already exists (don't create one just to announce a removal).
        if (await this.chatExists(eventId)) {
          await this.messenger.postEventSystemMessage(eventId, type, this.src('chatter.type.calendar.event_left', { name }));
        }
        return;
      }

      if (type === 'calendar.event.updated') {
        if (!(await this.chatExists(eventId))) return;
        await this.messenger.postEventSystemMessage(eventId, type, this.src('chatter.type.calendar.event_updated'));
        return;
      }
      // calendar.event.rsvp and others: tuples already resynced; no plaque.
    } catch (err) {
      this.logger.warn(
        `calendar system message failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  private async chatExists(eventId: string): Promise<boolean> {
    const chat = await this.db.chat.findFirst({
      where: { parentType: 'event', parentId: eventId },
      select: { id: true },
    });
    return !!chat;
  }

  private async nameOf(userId?: string): Promise<string | null> {
    if (!userId) return null;
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    if (!u) return null;
    return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.firstName;
  }
}

interface CalendarEventPayload {
  eventId?: string;
  eventTitle?: string;
  byUserId?: string;
  byName?: string;
  removedUserId?: string;
  recipientIds?: string[];
  [key: string]: unknown;
}
