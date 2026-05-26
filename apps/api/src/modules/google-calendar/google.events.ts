import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { GoogleCalendarService } from './google-calendar.service';

/**
 * Bridges local calendar changes (emitted by CalendarService as `google.push`)
 * to the outbound Google sync. Decoupled via EventBus — calendar module doesn't
 * import the Google module.
 */
@Injectable()
export class GoogleEventsListener implements OnModuleInit {
  private readonly logger = new Logger(GoogleEventsListener.name);

  constructor(
    private events: EventBusService,
    private google: GoogleCalendarService,
  ) {}

  onModuleInit() {
    this.events.on('google.push').subscribe((event) => {
      const p = event.payload as { userId?: string; eventId?: string; op?: string; googleEventId?: string };
      if (!p.userId) return;
      const task =
        p.op === 'delete'
          ? p.googleEventId
            ? this.google.deleteRemote(p.userId, p.googleEventId)
            : Promise.resolve()
          : p.eventId
            ? this.google.pushEvent(p.userId, p.eventId)
            : Promise.resolve();
      task.catch((e) => this.logger.warn(`google.push failed: ${e instanceof Error ? e.message : e}`));
    });
  }
}
