import { Injectable, OnModuleInit } from '@nestjs/common';
import { WorkspacePurgeRegistry } from '../workspaces/workspace-purge.registry';
import { NotesService } from './notes.service';

/**
 * Заметки в каскаде окончательного удаления организации: пространство заметок
 * организации (`ownerType = workspace`) внешним ключом на неё не связано и без хука
 * пережило бы удаление навсегда — вместе с грантами, индексом и привязками файлов.
 */
@Injectable()
export class NotesWorkspacePurgeProvider implements OnModuleInit {
  constructor(
    private readonly purges: WorkspacePurgeRegistry,
    private readonly notes: NotesService,
  ) {}

  onModuleInit(): void {
    this.purges.register('notes', {
      purge: (workspaceId) => this.notes.purgeSpaceOf('workspace', workspaceId),
    });
  }
}
