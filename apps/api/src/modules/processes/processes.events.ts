import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ProcessEngineService } from './process-engine.service';

/**
 * Подстраховка шиной (at-most-once): основной путь — СИНХРОННЫЙ хук
 * TasksService.settleLinkedProcess (ModuleRef 'ProcessesService'), как у ShopService.
 * Листенер идемпотентен — двойной вызов проигрывает на status-guard'е шага.
 */
@Injectable()
export class ProcessesEventsListener implements OnModuleInit {
  private readonly logger = new Logger(ProcessesEventsListener.name);

  constructor(
    private events: EventBusService,
    private engine: ProcessEngineService,
  ) {}

  onModuleInit(): void {
    this.events.on('task.completed').subscribe((event) => {
      const taskId = (event.payload as { taskId?: string }).taskId;
      if (!taskId) return;
      void this.engine.onTaskCompleted(taskId).catch((err) => {
        this.logger.error(`task.completed → process advance failed: ${err?.message ?? err}`);
      });
    });
    this.events.on('task.deleted').subscribe((event) => {
      const taskId = (event.payload as { taskId?: string }).taskId;
      if (!taskId) return;
      void this.engine.onTaskDeleted(taskId).catch((err) => {
        this.logger.error(`task.deleted → process fail failed: ${err?.message ?? err}`);
      });
    });
    this.events.on('task.cancelled').subscribe((event) => {
      const taskId = (event.payload as { taskId?: string }).taskId;
      if (!taskId) return;
      void this.engine.onTaskCancelled(taskId).catch((err) => {
        this.logger.error(`task.cancelled → process fail failed: ${err?.message ?? err}`);
      });
    });
  }
}
