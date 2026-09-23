import { Injectable, OnModuleInit } from '@nestjs/common';
import { WorkspacePurgeRegistry } from '../workspaces/workspace-purge.registry';
import { DriveTreeService } from './drive-tree.service';

/**
 * Диск в каскаде окончательного удаления организации: пространство организации
 * (`ownerType = workspace`) внешним ключом на неё не связано и без хука пережило бы
 * удаление навсегда — вместе с файлами, грантами и ссылками наружу.
 */
@Injectable()
export class DriveWorkspacePurgeProvider implements OnModuleInit {
  constructor(
    private readonly purges: WorkspacePurgeRegistry,
    private readonly tree: DriveTreeService,
  ) {}

  onModuleInit(): void {
    this.purges.register('drive', {
      purge: async (workspaceId) => {
        await this.tree.purgeOwnerSpaces('workspace', workspaceId);
      },
    });
  }
}
