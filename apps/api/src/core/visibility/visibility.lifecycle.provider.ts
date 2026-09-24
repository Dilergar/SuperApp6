import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { VisibilityPolicyService } from './visibility.policy.service';

/**
 * Хук каскада организации `visibility.owner` (политика `VisibilityPolicy` — полиморфный
 * владелец без FK): правила видимости организации и её настройки уходят с ней.
 */
@Injectable()
export class VisibilityLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly policies: VisibilityPolicyService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('visibility.owner', {
      purge: (workspaceId) => this.policies.purgeOwner(null, 'workspace', workspaceId),
      estimate: (workspaceId) => this.db.visibilityPolicy.count({ where: { ownerType: 'workspace', ownerId: workspaceId } }),
    });
  }
}
