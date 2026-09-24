import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { AnalyticsService } from './analytics.service';

/**
 * Хук каскада организации `analytics.workspace` (роллапы с измерением организации + сырьё):
 * роллапы — пачками (не одним DELETE на сотни тысяч строк), сырьё — джобом движка батчами с
 * повторным проходом (события, ещё летевшие в очереди, догоняются).
 */
@Injectable()
export class AnalyticsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly analytics: AnalyticsService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('analytics.workspace', {
      purge: (workspaceId, ctx) => this.analytics.forgetWorkspace(workspaceId, ctx.deadline),
      estimate: async (workspaceId) =>
        (await this.db.analyticsRollupEventDay.count({ where: { workspaceId } })) +
        (await this.db.analyticsRollupActorDay.count({ where: { workspaceId } })) +
        (await this.db.analyticsRollupSessionDay.count({ where: { workspaceId } })),
    });
  }
}
