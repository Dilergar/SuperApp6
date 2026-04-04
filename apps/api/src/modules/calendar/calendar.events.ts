import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { CalendarService } from './calendar.service';

/**
 * Listens to events from other modules and creates/updates calendar events.
 * This is the key pattern — modules are decoupled via events.
 */
@Injectable()
export class CalendarEventsListener implements OnModuleInit {
  constructor(
    private events: EventBusService,
    private calendarService: CalendarService,
  ) {}

  onModuleInit() {
    // When a task is created with addToCalendar=true, create a calendar event
    this.events.on('task.created').subscribe(async (event) => {
      const { taskId, creatorId, title, dueDate, addToCalendar } = event.payload;

      if (addToCalendar && dueDate) {
        try {
          await this.calendarService.createEventFromTask({
            taskId: taskId as string,
            userId: creatorId as string,
            title: title as string,
            dueDate: dueDate as string,
          });
        } catch (err) {
          console.error('[Calendar] Failed to create event from task:', err);
        }
      }
    });

    // When a task due date changes, update the linked calendar event
    this.events.on('task.updated').subscribe(async (event) => {
      const { taskId, changes } = event.payload;
      if ((changes as Record<string, unknown>)['dueDate'] !== undefined) {
        // Could update linked calendar event here
        console.log(`[Calendar] Task ${taskId} due date changed`);
      }
    });
  }
}
