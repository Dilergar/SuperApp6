import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { SignService } from './sign.service';

/**
 * Шаг каскада организации `sign.workspace` (политика `SignRequest`, `retain_legal`):
 * подписи В ОЖИДАНИИ закрываются как отменённые; поставленные подписи и акты — доказательства,
 * живут по закону (Цифровой кодекс ст. 62) и каскадом не трогаются.
 */
@Injectable()
export class SignLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly sign: SignService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('sign.workspace', {
      purge: async (workspaceId) => ({ rows: await this.sign.cancelAllForWorkspace(workspaceId) }),
      estimate: (workspaceId) => this.db.signRequest.count({ where: { workspaceId, status: 'pending' } }),
    });
  }
}
