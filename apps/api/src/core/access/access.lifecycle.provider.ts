import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { AccessService } from './access.service';

/**
 * Хук каскада организации `access.tuples` (политика `RelationTuple`): рёбра графа прав, где
 * организация — ресурс или субъект, снимаются путём движка (эпохи кэша прав бампаются).
 * Рёбра её сущностей уходят их путями, хвосты без FK — loose FK (рёбра реестра).
 */
@Injectable()
export class AccessLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly access: AccessService,
    private readonly db: DatabaseService,
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
  }
}
