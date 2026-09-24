import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { KeysCascadesService } from './api-keys/keys.cascades.service';

/**
 * Хук каскада организации `keys.workspace` (политики `Bot`, `ApiKey`): ключи API и боты
 * организации гаснут, KEK организации уходит на уничтожение (crypto-shredding); эпоха
 * keystore бампается ПОСЛЕ коммита — ключ перестаёт работать на всех инстансах сразу.
 */
@Injectable()
export class KeysLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly cascades: KeysCascadesService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('keys.workspace', {
      purge: async (workspaceId) => {
        await this.db.$transaction((tx) => this.cascades.onWorkspacePurge(tx, workspaceId));
        await this.cascades.afterScopeDestroyCommitted();
      },
      estimate: async (workspaceId) =>
        (await this.db.apiKey.count({ where: { OR: [{ workspaceId }, { bot: { workspaceId } }], revokedAt: null } })) +
        (await this.db.bot.count({ where: { workspaceId, status: { not: 'archived' } } })),
    });
  }
}
