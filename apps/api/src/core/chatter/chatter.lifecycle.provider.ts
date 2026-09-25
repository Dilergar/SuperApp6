import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, LifecycleSubjectHookRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../lifecycle/lifecycle.purge.registry';
import { ChatterService } from './chatter.service';

/**
 * Шаг хроники в стирании человека (`chatter.subject`, политика `ChatterEntry`): запись
 * остаётся (это история записи организации или собеседника), снимок имени актора
 * псевдонимизируется меткой «удалённый пользователь» в языке источника — зритель
 * перерисует её при чтении. Хранитель под заморозкой — имя в хронике улика: шаг ждёт снятия.
 */
@Injectable()
export class ChatterLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly chatter: ChatterService,
    private readonly canary: LifecycleCanaryRegistry,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.subjectHooks.register('chatter.subject', {
      erase: async (userId, ctx) => {
        if (ctx.subjectHeld) {
          ctx.held(1);
          return { rows: 0 };
        }
        return { rows: await this.chatter.redactActor(userId) };
      },
    });
    this.canary.register('chatter.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки: записи, где человек — актор со снимком имени, — в истории организации
   * (остаётся ей, уходит с её каскадом) и в истории записи соседа (остаётся); записи соседа, где
   * человек — цель (`targetName`) и значение «было → стало» (`from`). Имени в них после
   * стирания нет.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const actor = { actorId: ctx.userId, actorName: `Canary ${ctx.name}` };
    const org = await this.db.chatterEntry.create({ data: { ...actor, refType: 'workspace', refId: ctx.workspaceId, workspaceId: ctx.workspaceId, typeKey: 'staff.role_changed', payload: { note: ctx.marker } }, select: { id: true } });
    const peers = await this.db.chatterEntry.create({ data: { ...actor, refType: 'task', refId: randomUUID(), typeKey: 'task.deadline_changed' }, select: { id: true } });
    // Человек — не актор, а цель записи и значение «было → стало» (имена парой с id)
    const peer = { actorId: ctx.peerId, actorName: 'Canary Peer', workspaceId: ctx.workspaceId };
    const target = await this.db.chatterEntry.create({
      data: { ...peer, refType: 'workspace', refId: ctx.workspaceId, typeKey: 'staff.position_removed', payload: { targetUserId: ctx.userId, targetName: `Canary ${ctx.name}`, positionName: ctx.marker } },
      select: { id: true },
    });
    const change = await this.db.chatterEntry.create({
      data: {
        ...peer,
        refType: 'asset',
        refId: randomUUID(),
        typeKey: 'asset.custodian_set',
        changes: [{ field: 'custodian', label: 'Custodian', from: `Canary ${ctx.name}`, to: 'Canary Peer', fromUserId: ctx.userId, toUserId: ctx.peerId, raw: { from: `Canary ${ctx.name}`, to: 'Canary Peer', kind: 'text' } }],
      },
      select: { id: true },
    });
    return [
      { policy: 'ChatterEntry', id: org.id.toString(), expect: 'kept', tenant: true },
      { policy: 'ChatterEntry', id: peers.id.toString(), expect: 'kept' },
      { policy: 'ChatterEntry', id: target.id.toString(), expect: 'kept', tenant: true },
      { policy: 'ChatterEntry', id: change.id.toString(), expect: 'kept', tenant: true },
    ];
  }
}
