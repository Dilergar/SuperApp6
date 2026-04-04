import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';

/**
 * Listens to task-related events from other modules.
 * This is how modules communicate without direct dependencies.
 */
@Injectable()
export class TaskEventsListener implements OnModuleInit {
  constructor(private events: EventBusService) {}

  onModuleInit() {
    // Example: when a workspace is deleted, we might want to handle orphaned tasks
    this.events.on('workspace.deleted').subscribe((event) => {
      console.log(`[Tasks] Workspace deleted: ${event.payload['workspaceId']}`);
      // Could reassign tasks, archive them, etc.
    });
  }
}
