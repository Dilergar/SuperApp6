import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../lifecycle/lifecycle.purge.registry';
import { ShareLinksService } from './share-links.service';

/**
 * Хук каскада организации `share-links.workspace` (политики `ShareLink`, `ShareLinkGuest`):
 * все ссылки организации наружу отзываются системой, её гости (имя + номер — ПДн) удаляются.
 */
@Injectable()
export class ShareLinksLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly shareLinks: ShareLinksService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('share-links.workspace', {
      purge: async (workspaceId) => {
        const { revoked, guests } = await this.shareLinks.forgetWorkspace(workspaceId);
        return { rows: revoked + guests };
      },
      estimate: async (workspaceId) =>
        (await this.db.shareLink.count({ where: { OR: [{ workspaceId }, { ownerType: 'workspace', ownerId: workspaceId }], revokedAt: null } })) +
        (await this.db.shareLinkGuest.count({ where: { ownerType: 'workspace', ownerId: workspaceId } })),
    });
  }
}
