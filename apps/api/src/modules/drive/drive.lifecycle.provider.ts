import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../../core/files/files.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
import { DriveTreeService } from './drive-tree.service';
import { DriveService } from './drive.service';

/**
 * Диск в движке сроков core/lifecycle:
 *  - `drive.trash` (политика `DriveNode`) — корзина: корни старше срока уходят навсегда тем же
 *    путём, что «удалить навсегда» (гранты, привязки, ссылки наружу, файлы, индекс), пачками;
 *  - `drive.workspace` (политика `DriveSpace`) — каскад организации: её пространства
 *    (`ownerType = workspace`) внешним ключом не связаны и без шага пережили бы её навсегда
 *    вместе с файлами, грантами и ссылками наружу.
 */
@Injectable()
export class DriveLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly tree: DriveTreeService,
    private readonly db: DatabaseService,
    private readonly drive: DriveService,
    private readonly files: FilesService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.handlers.register('drive.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.tree.purgeTrashBatch({ limit, cursor, releasable }),
      estimate: () => this.tree.countTrashDue(),
    });
    this.tenantHooks.register('drive.workspace', {
      purge: (workspaceId, ctx) => this.tree.purgeOwnerSpaces('workspace', workspaceId, ctx.deadline),
      estimate: (workspaceId) => this.db.driveNode.count({ where: { space: { ownerType: 'workspace', ownerId: workspaceId } } }),
    });
    // Стирание человека: его личный Диск целиком (Диск — «дом» файла: файлы уходят и из мест, куда ими делились)
    this.subjectHooks.register('drive.subject', { erase: (userId, ctx) => this.tree.purgeOwnerSpaces('user', userId, ctx.deadline, { held: (n) => ctx.held(n) }) });
    this.canary.register('drive.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки живым путём Диска: личное пространство человека, папка, файл в ней (узел —
   * «дом» файла), звезда и недавнее. Всё исчезает — строки, байты файла, проекции поиска.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const folder = await this.drive.createFolder(ctx.userId, { name: ctx.marker });
    const file = await this.files.createCanaryFile({ profile: 'drive_file', ownerType: 'user', ownerId: ctx.userId, uploaderId: ctx.userId, name: `${ctx.marker}.txt`, mime: 'text/plain', content: ctx.marker });
    const node = await this.drive.attachFile(ctx.userId, { parentId: folder.id, fileId: file.id });
    const space = await this.db.driveSpace.findFirst({ where: { ownerType: 'user', ownerId: ctx.userId, kind: 'personal' }, select: { id: true } });
    const star = await this.db.driveStar.create({ data: { userId: ctx.userId, nodeId: node.id }, select: { id: true } });
    const recent = await this.db.driveRecent.create({ data: { userId: ctx.userId, nodeId: node.id }, select: { id: true } });
    return [
      ...(space ? [{ policy: 'DriveSpace', id: space.id, expect: 'gone' as const }] : []),
      { policy: 'DriveNode', id: folder.id, expect: 'gone' },
      { policy: 'DriveNode', id: node.id, expect: 'gone' },
      { policy: 'FileObject', id: file.id, expect: 'gone' },
      { policy: 'blob:drive_file', id: file.storageKey, expect: 'gone' },
      { policy: 'DriveStar', id: star.id, expect: 'gone' },
      { policy: 'DriveRecent', id: recent.id, expect: 'gone' },
    ];
  }
}
