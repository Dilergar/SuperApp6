import { Injectable, OnModuleInit } from '@nestjs/common';
import type { RichCardAction, RichCardField, RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { TasksService } from './tasks.service';

const STATUS_WORDS: Record<string, string> = {
  todo: 'К выполнению',
  in_progress: 'В работе',
  on_review: 'На проверке',
  done: 'Выполнена',
  cancelled: 'Отменена',
};

const TASK_ROLE_WORDS: Record<string, string> = {
  creator: 'Постановщик',
  executor: 'Исполнитель',
  co_executor: 'Соисполнитель',
  observer: 'Наблюдатель',
};

/**
 * Registers the 'task' rich-card renderer + task action handlers. Buttons are
 * permission/state-filtered for the viewer (mirrors TasksService gating). Actions delegate to
 * TasksService — the service re-checks the role itself, so the engine cap here is the floor.
 */
@Injectable()
export class TasksRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    this.registry.registerRenderer('task', (deps, viewerId, refId) => this.renderTask(deps, viewerId, refId));

    this.registry.registerAction('task.accept', {
      requiredCapability: 'task.view',
      handler: (userId, refId) => this.tasks.acceptWork(userId, refId).then(() => undefined),
    });
    this.registry.registerAction('task.return', {
      requiredCapability: 'task.view',
      handler: (userId, refId) => this.tasks.returnWork(userId, refId).then(() => undefined),
    });
    this.registry.registerAction('task.take', {
      requiredCapability: 'task.view',
      handler: (userId, refId) =>
        this.tasks.updateTask(userId, refId, { status: 'in_progress' }).then(() => undefined),
    });
  }

  private async renderTask(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
  ): Promise<RichCardPayload | null> {
    if (!(await deps.access.can({ type: 'user', id: viewerId }, 'task.view', refId))) return null;
    const task = await deps.db.task.findUnique({
      where: { id: refId },
      select: {
        title: true,
        status: true,
        priority: true,
        creatorId: true,
        coinReward: true,
        participants: { select: { userId: true, role: true, status: true } },
      },
    });
    if (!task) return null;

    const isCreator = task.creatorId === viewerId;
    const myP = task.participants.find((p) => p.userId === viewerId);
    const myRole = isCreator ? 'creator' : myP?.role ?? null;

    const fields: RichCardField[] = [
      { label: 'Статус', value: STATUS_WORDS[task.status] ?? task.status },
    ];
    if (myRole) fields.push({ label: 'Ваша роль', value: TASK_ROLE_WORDS[myRole] ?? myRole });
    if (task.coinReward > 0) fields.push({ label: 'Награда', value: `${task.coinReward} 🪙` });

    const actions: RichCardAction[] = [];
    const open = task.status !== 'done' && task.status !== 'cancelled';
    const hasSubmitted = task.participants.some(
      (p) => p.role !== 'observer' && p.status === 'submitted',
    );
    // Creator can accept / return when someone has submitted work.
    if (isCreator && open && hasSubmitted) {
      actions.push({ key: 'task.accept', label: 'Принять', style: 'primary' });
      actions.push({ key: 'task.return', label: 'Вернуть', style: 'danger' });
    }
    // A worker who hasn't submitted yet can take the task into work (todo → in_progress).
    if (
      !isCreator &&
      open &&
      myP &&
      myP.role !== 'observer' &&
      myP.status === 'pending' &&
      task.status === 'todo'
    ) {
      actions.push({ key: 'task.take', label: 'Взять в работу', style: 'primary' });
    }

    return {
      kind: 'rich_card',
      cardType: 'task',
      ref: { type: 'task', id: refId },
      title: task.title,
      subtitle: STATUS_WORDS[task.status] ?? null,
      icon: '✅',
      imageUrl: null,
      fields,
      progress: null,
      status: STATUS_WORDS[task.status] ?? null,
      actions,
      href: `/tasks/${refId}`,
    };
  }
}
