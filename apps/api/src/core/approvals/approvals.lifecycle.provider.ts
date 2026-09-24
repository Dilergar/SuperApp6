import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { ApprovalsService } from './approvals.service';

/**
 * Хук каскада организации `approvals.workspace` (политика `ApprovalRequest`): живые заявки
 * организации больше никого не ждут — отменяются (стопки людей чистеют); закрытые остаются
 * историей до каскада FK строки организации.
 */
@Injectable()
export class ApprovalsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly approvals: ApprovalsService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('approvals.workspace', {
      purge: async (workspaceId) => ({ rows: await this.approvals.cancelAllForWorkspace(workspaceId) }),
      estimate: (workspaceId) => this.db.approvalRequest.count({ where: { workspaceId, status: 'pending' } }),
    });
  }
}
