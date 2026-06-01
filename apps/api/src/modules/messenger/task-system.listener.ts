import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { MessengerService } from './messenger.service';

/**
 * Bridges task-lifecycle events onto the task's CONTEXT chat as system messages
 * (centered plaques: "X назначил(а) задачу", "Работа принята", …). Best-effort —
 * a failure here never affects the task operation. The chat is created lazily via
 * MessengerService.postTaskSystemMessage.
 *
 * Lives in the messenger module (depends only on EventBus + MessengerService — no
 * cycle). Separate from the notifications listener: this writes chat plaques, that
 * writes notification rows; both subscribe to task.* independently.
 */
@Injectable()
export class TaskSystemListener implements OnModuleInit {
  private readonly logger = new Logger(TaskSystemListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly messenger: MessengerService,
  ) {}

  onModuleInit() {
    this.events.onPattern('task.*').subscribe((e) => {
      void this.handle(e.type, (e.payload ?? {}) as TaskEventPayload);
    });
  }

  private async handle(type: string, p: TaskEventPayload): Promise<void> {
    try {
      const taskId = p.taskId;
      if (!taskId) return;

      const text = this.textFor(type, p.byName);
      if (!text) return; // event type we don't render

      await this.messenger.postTaskSystemMessage(taskId, type, text);
    } catch (err) {
      this.logger.warn(
        `task system message failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  /** Russian plaque text per task.* event, or null for events we ignore. */
  private textFor(type: string, byName?: string): string | null {
    const who = byName?.trim() || 'Кто-то';
    switch (type) {
      case 'task.assigned':
        return `${who} назначил(а) задачу`;
      case 'task.submitted':
        return `${who} сдал(а) работу на проверку`;
      case 'task.accepted':
        return 'Работа принята';
      case 'task.returned':
        return 'Работа возвращена на доработку';
      case 'task.completed':
        return 'Задача выполнена';
      default:
        return null;
    }
  }
}

interface TaskEventPayload {
  taskId?: string;
  taskTitle?: string;
  byUserId?: string;
  byName?: string;
  recipientIds?: string[];
  [key: string]: unknown;
}
