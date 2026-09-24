import { Injectable, OnModuleInit } from '@nestjs/common';
import { TASK_STATUS_META, type RichCardAction, type RichCardField, type RichCardPayload, type TaskStatus } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { I18nService } from '../../shared/i18n/i18n.service';
import { TasksService } from './tasks.service';

/**
 * Registers the 'task' rich-card renderer + task action handlers. Buttons are
 * permission/state-filtered for the viewer (mirrors TasksService gating). Actions delegate to
 * TasksService — the service re-checks the role itself, so the engine cap here is the floor.
 *
 * Ни одной строки для человека в файле: статусы и роли берутся из каталога по
 * ключу, выведенному из самого значения (`tasks.status.<status>`), — карточка
 * рисуется в языке ЗРИТЕЛЯ при каждом чтении, а не в языке того, кто её писал.
 */
@Injectable()
export class TasksRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly tasks: TasksService,
    private readonly i18n: I18nService,
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
      where: { id: refId, deletedAt: null },
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

    const t = this.i18n.t;
    const isCreator = task.creatorId === viewerId;
    const myP = task.participants.find((p) => p.userId === viewerId);
    const myRole = isCreator ? 'creator' : myP?.role ?? null;
    // Неизвестный статус (миграция, новое значение перечисления) не должен
    // показывать сам ключ: падаем на сырое значение, как и раньше.
    const statusKey = `tasks.status.${task.status}`;
    const statusLabel = t.has(statusKey) ? t(statusKey) : task.status;

    const fields: RichCardField[] = [{ label: t('tasks.card.status'), value: statusLabel }];
    if (myRole) {
      const roleKey = `tasks.role.${myRole}`;
      fields.push({ label: t('tasks.card.myRole'), value: t.has(roleKey) ? t(roleKey) : myRole });
    }
    if (task.coinReward > 0) {
      fields.push({ label: t('tasks.card.reward'), value: `${task.coinReward} 🪙` });
    }

    const actions: RichCardAction[] = [];
    const open = task.status !== 'done' && task.status !== 'cancelled';
    const hasSubmitted = task.participants.some(
      (p) => p.role !== 'observer' && p.status === 'submitted',
    );
    // Creator can accept / return when someone has submitted work.
    if (isCreator && open && hasSubmitted) {
      actions.push({ key: 'task.accept', label: t('tasks.detail.accept'), style: 'primary' });
      actions.push({ key: 'task.return', label: t('tasks.detail.return'), style: 'danger' });
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
      actions.push({ key: 'task.take', label: t('tasks.detail.take'), style: 'primary' });
    }

    return {
      kind: 'rich_card',
      cardType: 'task',
      ref: { type: 'task', id: refId },
      title: task.title,
      subtitle: statusLabel,
      icon: '✅',
      imageUrl: null,
      fields,
      progress: null,
      status: statusLabel,
      // Тон называет ПРОВАЙДЕР: веб больше не угадывает его по самому слову.
      statusTone: TASK_STATUS_META[task.status as TaskStatus]?.tone ?? 'neutral',
      actions,
      href: `/tasks/${refId}`,
    };
  }
}
