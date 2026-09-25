import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../lifecycle/lifecycle.purge.registry';
import { AccessService } from './access.service';

/**
 * Ресурсы графа прав, чей id — id человека (календарь, вишлист, карточка): их рёбра —
 * личные связи человека и уходят вместе с ним. Прочие ресурсы человека (задачи, заметки,
 * узлы Диска) снимают свои рёбра путями своих модулей.
 */
const PERSONAL_RESOURCE_TYPES = ['calendar', 'wishlist', 'card'] as const;

/**
 * Шаги движка прав в жизненном цикле (политика `RelationTuple`):
 *  - `access.tuples` — каскад организации: рёбра, где организация — ресурс или субъект;
 *  - `access.subject` — стирание человека: рёбра, где он субъект (гранты ему), и его личные
 *    ресурсы. Путём движка — эпохи кэша прав бампаются, чужой кэш не держит доступ.
 * Рёбра сущностей уходят их путями, хвосты без FK — loose FK (рёбра реестра).
 */
@Injectable()
export class AccessLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly access: AccessService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('access.tuples', {
      purge: async (workspaceId) => {
        await this.access.revokeResource('workspace', workspaceId);
        await this.access.revokeSubject('workspace', workspaceId);
      },
      estimate: (workspaceId) =>
        this.db.relationTuple.count({
          where: { OR: [{ resourceType: 'workspace', resourceId: workspaceId }, { subjectType: 'workspace', subjectId: workspaceId }] },
        }),
    });
    this.subjectHooks.register('access.subject', {
      erase: async (userId) => {
        const rows = await this.db.relationTuple.count({
          where: { OR: [{ subjectType: 'user', subjectId: userId }, { resourceType: { in: [...PERSONAL_RESOURCE_TYPES] }, resourceId: userId }] },
        });
        await this.access.revokeSubject('user', userId);
        for (const type of PERSONAL_RESOURCE_TYPES) await this.access.revokeResource(type, userId);
        return { rows };
      },
    });
    this.canary.register('access.subject', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: грант человеку (сосед открыл ему календарь) и грант на его личный ресурс — оба уходят. */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const toHim = await this.db.relationTuple.create({ data: { resourceType: 'calendar', resourceId: ctx.peerId, relation: 'busy_viewer', subjectType: 'user', subjectId: ctx.userId }, select: { id: true } });
    const onHis = await this.db.relationTuple.create({ data: { resourceType: 'calendar', resourceId: ctx.userId, relation: 'busy_viewer', subjectType: 'user', subjectId: ctx.peerId }, select: { id: true } });
    return [
      { policy: 'RelationTuple', id: toHim.id, expect: 'gone' },
      { policy: 'RelationTuple', id: onHis.id, expect: 'gone' },
    ];
  }
}
