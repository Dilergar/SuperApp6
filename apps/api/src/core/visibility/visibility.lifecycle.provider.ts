import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, LifecycleTenantHookRegistry, type LifecycleCanaryContext, type LifecycleCanaryPlant } from '../lifecycle/lifecycle.purge.registry';
import { VisibilityPolicyService } from './visibility.policy.service';

/**
 * Хук каскада организации `visibility.owner` (политика `VisibilityPolicy` — полиморфный
 * владелец без FK): правила видимости организации и её настройки уходят с ней. Правила
 * человека стирает корневой шаг `users.account` (`purgeOwner`) — посев канарейки здесь.
 */
@Injectable()
export class VisibilityLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly policies: VisibilityPolicyService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('visibility.owner', {
      purge: (workspaceId) => this.policies.purgeOwner(null, 'workspace', workspaceId),
      estimate: (workspaceId) => this.db.visibilityPolicy.count({ where: { ownerType: 'workspace', ownerId: workspaceId } }),
    });
    this.canary.register('visibility.user', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: черновик правил своей карточки (черновик не действует — чужим показ не меняется). */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const row = await this.db.visibilityPolicy.create({
      data: { ownerType: 'user', ownerId: ctx.userId, recordType: 'user.card', version: 1, status: 'draft', draftToken: ctx.marker, createdById: ctx.userId },
      select: { id: true },
    });
    return [{ policy: 'VisibilityPolicy', id: row.id, expect: 'gone' }];
  }
}
