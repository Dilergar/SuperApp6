import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { EntitlementsService } from './entitlements.service';

/**
 * Хук каскада организации `entitlements.subject` (подписка, гранты, оверрайды, счётчики —
 * строки без FK): тариф организации забывается путём движка (отметка «триал использован»
 * остаётся — один бизнес-триал на человека).
 */
@Injectable()
export class EntitlementsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly entitlements: EntitlementsService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('entitlements.subject', {
      purge: async (workspaceId) => {
        await this.db.$transaction((tx) => this.entitlements.forgetSubject(tx, { type: 'workspace', id: workspaceId }));
      },
      estimate: async (workspaceId) =>
        (await this.db.subjectSubscription.count({ where: { subjectType: 'workspace', subjectId: workspaceId } })) +
        (await this.db.quotaCounter.count({ where: { subjectType: 'workspace', subjectId: workspaceId } })),
    });
  }
}
