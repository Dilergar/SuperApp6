import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { DatabaseService } from '../../shared/database/database.service';
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
  ) {}

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

      // Плашки структурные: текст собирается при чтении в языке зрителя, имена людей лежат
      // парами с id (стирание их находит). Нет имени — пусто/ключ, слово подберёт язык читателя
      if (type === 'calendar.event.created' || type === 'calendar.event.invited') {
        if (type === 'calendar.event.invited') await this.messenger.syncEventChatMembers(eventId);
        // Имя без id стирание не нашло бы — актор без id остаётся «кем-то»
        const who = p.byUserId ? (p.byName ?? (await this.nameOf(p.byUserId)))?.trim() || '' : '';
        await this.messenger.postEventSystemMessage(eventId, type, {
          typeKey: type === 'calendar.event.created' ? 'calendar.event_created' : 'calendar.event_invited',
          values: { actorName: who },
          actorId: p.byUserId ?? null,
        });
        return;
      }

      if (type === 'calendar.event.participant_removed') {
        const name = (await this.nameOf(p.removedUserId))?.trim() || '';
        await this.messenger.syncEventChatMembers(eventId);
        // Plaque only if a chat already exists (don't create one just to announce a removal).
        if (await this.chatExists(eventId) && p.removedUserId) {
          await this.messenger.postEventSystemMessage(eventId, type, {
            typeKey: 'calendar.event_left',
            values: name ? { targetName: name, targetUserId: p.removedUserId } : { targetNameKey: 'messenger.participantFallback', targetUserId: p.removedUserId },
          });
        }
        return;
      }

      if (type === 'calendar.event.updated') {
        if (!(await this.chatExists(eventId))) return;
        await this.messenger.postEventSystemMessage(eventId, type, { typeKey: 'calendar.event_updated' });
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
