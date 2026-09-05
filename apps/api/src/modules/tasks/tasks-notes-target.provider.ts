import { Injectable, OnModuleInit } from '@nestjs/common';
import { NoteTargetRegistry } from '../notes/notes-targets.registry';
import { TasksService } from './tasks.service';

/**
 * Задача как цель привязки заметки (реестр Заметок; направление импорта перевёрнуто —
 * Задачи регистрируются сами). Право на задачу решает TasksService.
 */
@Injectable()
export class TasksNotesTargetProvider implements OnModuleInit {
  constructor(
    private readonly registry: NoteTargetRegistry,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.registry.register('task', {
      canView: async (viewerId, taskId) => {
        try {
          await this.tasks.getTask(viewerId, taskId);
          return true;
        } catch {
          return false;
        }
      },
      describe: async (viewerId, taskId) => {
        try {
          const task = await this.tasks.getTask(viewerId, taskId);
          return { title: task.title, url: `/tasks/${task.id}`, workspaceId: task.workspaceId ?? null };
        } catch {
          return null;
        }
      },
      search: async (viewerId, ctx, q, limit) => {
        const page = await this.tasks.getTasks(viewerId, {
          search: q || undefined,
          workspaceId: ctx.workspaceId,
          limit,
          page: 1,
        });
        return page.items.map((t) => ({
          targetType: 'task' as const,
          id: t.id,
          title: t.title,
          subtitle: t.status ? String(t.status) : null,
        }));
      },
    });
  }
}
