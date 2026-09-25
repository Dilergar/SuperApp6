import { Injectable, OnModuleInit } from '@nestjs/common';
import { TASK_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
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
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly tasks: TasksService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
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
    this.subjectHooks.register('tasks.subject', {
      erase: (userId, ctx) =>
        this.tasks.purgePersonalTasks(userId, { deadline: ctx.deadline, held: (n) => ctx.held(n), releasable: (tx, ids) => ctx.releasable(tx, 'Task', ids) }),
    });
    this.canary.register('tasks.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: личная задача человека с подзадачей и записью хроники — исчезают (запись
   * хроники — воркером loose FK); задача человека в организации — остаётся ей и уходит с её
   * каскадом.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const personal = await this.db.task.create({ data: { title: ctx.marker, description: ctx.marker, creatorId: ctx.userId }, select: { id: true } });
    const sub = await this.db.task.create({ data: { title: ctx.marker, creatorId: ctx.userId, parentId: personal.id }, select: { id: true } });
    const trail = await this.db.chatterEntry.create({ data: { refType: 'task', refId: personal.id, actorId: ctx.userId, actorName: `Canary ${ctx.name}`, typeKey: 'task.deadline_changed' }, select: { id: true } });
    const org = await this.db.task.create({ data: { title: ctx.marker, creatorId: ctx.userId, workspaceId: ctx.workspaceId }, select: { id: true } });
    return [
      { policy: 'Task', id: personal.id, expect: 'gone' },
      { policy: 'Task', id: sub.id, expect: 'gone' },
      { policy: 'ChatterEntry', id: trail.id.toString(), expect: 'gone' },
      { policy: 'Task', id: org.id, expect: 'kept', tenant: true },
    ];
  }

  private cutoff(): Date {
    return new Date(Date.now() - TASK_LIMITS.trashRetentionDays * 86_400_000);
  }
}
