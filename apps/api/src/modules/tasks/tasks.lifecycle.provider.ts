import { Injectable, OnModuleInit } from '@nestjs/common';
import { TASK_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
import { TasksService } from './tasks.service';

/**
 * Задачи в движке сроков core/lifecycle:
 *  - `tasks.trash` (политика `Task`) — корзина `TASK_LIMITS.trashRetentionDays`: корни
 *    корзины уходят навсегда с поддеревом (награды вернулись ещё при скрытии; повтор — страховка);
 *  - `tasks.workspace` — каскад организации: задачи уходят путём модуля, а не пачкой SQL
 *    (эскроу наград, чаты, права, вложения).
 */
@Injectable()
export class TasksLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly tasks: TasksService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('tasks.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.tasks.purgeTrashBatch({ before: this.cutoff(), limit, cursor, releasable }),
      estimate: () => this.tasks.countTrashDue(this.cutoff()),
    });
    this.tenantHooks.register('tasks.workspace', {
      purge: (workspaceId, ctx) =>
        this.tasks.purgeWorkspaceTasks(workspaceId, {
          deadline: ctx.deadline,
          checkpoint: () => ctx.checkpoint(),
          releasable: (tx, ids) => ctx.releasable(tx, 'Task', ids),
        }),
      estimate: (workspaceId) => this.db.task.count({ where: { workspaceId } }),
    });
  }

  private cutoff(): Date {
    return new Date(Date.now() - TASK_LIMITS.trashRetentionDays * 86_400_000);
  }
}
