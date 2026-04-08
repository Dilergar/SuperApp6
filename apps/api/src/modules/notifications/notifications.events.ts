import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService, AppEvent } from '../../shared/events/event-bus.service';
import { NotificationsService } from './notifications.service';
import type { NotificationType } from '@superapp/shared';

/**
 * Bridge between the internal EventBus and the NotificationsService.
 *
 * Other modules (contacts, tasks, calendar, ...) only know about the
 * EventBus — they don't import NotificationsService directly. This keeps
 * modules decoupled: removing or replacing the notifications backend does
 * not require touching any other module.
 *
 * Rule: one EventBus event → zero or more notification rows. The mapping
 * lives here (not inside the emitting module), so notification semantics
 * stay in one place.
 */
@Injectable()
export class NotificationsEventsListener implements OnModuleInit {
  private readonly logger = new Logger(NotificationsEventsListener.name);

  constructor(
    private events: EventBusService,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.events.onPattern('contact.*').subscribe((event) => {
      this.handleContactEvent(event).catch((err) =>
        this.logger.error(
          `Failed to handle ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });

    this.events.onPattern('task.*').subscribe((event) => {
      this.handleTaskEvent(event).catch((err) =>
        this.logger.error(
          `Failed to handle ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });

    this.events.onPattern('calendar.*').subscribe((event) => {
      this.handleCalendarEvent(event).catch((err) =>
        this.logger.error(
          `Failed to handle ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  }

  // ------------------------------------------------------------
  // Contacts
  // ------------------------------------------------------------
  private async handleContactEvent(event: AppEvent) {
    const payload = event.payload;

    switch (event.type) {
      case 'contact.invitation.sent': {
        // Notify recipient (if they are already registered).
        const toUserId = payload['toUserId'] as string | null | undefined;
        if (!toUserId) return;
        await this.emit(toUserId, 'contact.invitation.received', payload);
        return;
      }
      case 'contact.invitation.activated': {
        // Pending invitation surfaced when recipient finally registered.
        const toUserId = payload['toUserId'] as string | undefined;
        if (!toUserId) return;
        await this.emit(toUserId, 'contact.invitation.received', payload);
        return;
      }
      case 'contact.invitation.accepted': {
        // Notify the original sender that their invitation was accepted.
        const fromUserId = payload['fromUserId'] as string | undefined;
        if (!fromUserId) return;
        await this.emit(fromUserId, 'contact.invitation.accepted', payload);
        return;
      }
      case 'contact.invitation.rejected': {
        const fromUserId = payload['fromUserId'] as string | undefined;
        if (!fromUserId) return;
        await this.emit(fromUserId, 'contact.invitation.rejected', payload);
        return;
      }
      case 'contact.invitation.cancelled': {
        // Notify recipient (if they already existed) that the invitation was cancelled.
        const toUserId = payload['toUserId'] as string | null | undefined;
        if (!toUserId) return;
        await this.emit(toUserId, 'contact.invitation.cancelled', payload);
        return;
      }
      case 'contact.linked': {
        // Fire-and-forget, mostly for activity feed — no push by default.
        const userIds = (payload['userIds'] as string[] | undefined) ?? [];
        for (const uid of userIds) {
          await this.emit(uid, 'contact.linked', {
            ...payload,
            otherUserId: userIds.find((id) => id !== uid) ?? '',
            otherName: payload['otherNameByUser']
              ? (payload['otherNameByUser'] as Record<string, string>)[uid] ?? ''
              : '',
          });
        }
        return;
      }
      case 'contact.removed': {
        // Notify both sides — quiet notification (no push).
        const userIds = (payload['userIds'] as string[] | undefined) ?? [];
        for (const uid of userIds) {
          await this.emit(uid, 'contact.removed', payload);
        }
        return;
      }
      default:
        // Unknown contact.* subtype — ignore silently.
        return;
    }
  }

  // ------------------------------------------------------------
  // Tasks (stub for future wire-up)
  // ------------------------------------------------------------
  private async handleTaskEvent(event: AppEvent) {
    const payload = event.payload;
    switch (event.type) {
      case 'task.assigned': {
        const assigneeId = payload['assigneeId'] as string | undefined;
        if (!assigneeId) return;
        await this.emit(assigneeId, 'task.assigned', payload);
        return;
      }
      case 'task.completed': {
        const creatorId = payload['creatorId'] as string | undefined;
        if (!creatorId) return;
        await this.emit(creatorId, 'task.completed', payload);
        return;
      }
      case 'task.commented': {
        const notifyUserIds = (payload['notifyUserIds'] as string[] | undefined) ?? [];
        for (const uid of notifyUserIds) {
          await this.emit(uid, 'task.commented', payload);
        }
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------
  // Calendar (stub for future wire-up)
  // ------------------------------------------------------------
  private async handleCalendarEvent(event: AppEvent) {
    const payload = event.payload;
    switch (event.type) {
      case 'calendar.event.invited': {
        const inviteeId = payload['inviteeId'] as string | undefined;
        if (!inviteeId) return;
        await this.emit(inviteeId, 'calendar.event.invited', payload);
        return;
      }
      case 'calendar.event.reminder': {
        const userId = payload['userId'] as string | undefined;
        if (!userId) return;
        await this.emit(userId, 'calendar.event.reminder', payload);
        return;
      }
      default:
        return;
    }
  }

  private async emit(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ) {
    await this.notifications.notify(userId, type, payload);
  }
}
