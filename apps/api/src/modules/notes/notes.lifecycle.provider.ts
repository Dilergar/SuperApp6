import { Injectable, OnModuleInit } from '@nestjs/common';
import { NOTE_LIMITS, decodeCursor, encodeCursor } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry, type LifecyclePurgeBatchContext } from '../../core/lifecycle/lifecycle.purge.registry';
import { NotesFoldersService } from './notes-folders.service';
import { NotesService } from './notes.service';

const FOLDER_CURSOR = { i: 'uuid' } as const;

/**
 * Заметки в движке сроков core/lifecycle:
 *  - `notes.trash` (политики `Note` и `NoteFolder`) — корзина 30 дней: заметки тем же путём,
 *    что «удалить навсегда» (привязки файлов, гранты, строки, индекс), папки — гранты и
 *    материализованный путь заметок; пачками, удерживаемое заморозкой остаётся;
 *  - `notes.workspace` (политика `NoteSpace`) — каскад организации: её пространство заметок
 *    внешним ключом не связано и без шага пережило бы её навсегда.
 */
@Injectable()
export class NotesLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly notes: NotesService,
    private readonly folders: NotesFoldersService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('notes.trash', {
      purgeBatch: (ctx) => (ctx.policy.id === 'NoteFolder' ? this.foldersBatch(ctx) : this.notes.purgeTrashBatch({ before: this.cutoff(), limit: ctx.limit, cursor: ctx.cursor, releasable: ctx.releasable })),
      estimate: ({ policy }) =>
        policy.id === 'NoteFolder'
          ? this.db.noteFolder.count({ where: { deletedAt: { lt: this.cutoff() } } })
          : this.db.note.count({ where: { deletedAt: { lt: this.cutoff() } } }),
    });
    this.tenantHooks.register('notes.workspace', {
      purge: (workspaceId, ctx) => this.notes.purgeSpaceOf('workspace', workspaceId, ctx.deadline),
      estimate: (workspaceId) => this.db.note.count({ where: { space: { ownerType: 'workspace', ownerId: workspaceId } } }),
    });
  }

  private cutoff(): Date {
    return new Date(Date.now() - NOTE_LIMITS.trashRetentionDays * 86_400_000);
  }

  private async foldersBatch({ limit, cursor, releasable }: LifecyclePurgeBatchContext) {
    const after = decodeCursor(cursor, FOLDER_CURSOR)?.i ?? null;
    const res = await this.folders.purgeTrashFoldersBatch({ before: this.cutoff(), limit, after, releasable });
    return { rows: res.rows, more: res.more, cursor: res.last ? encodeCursor({ i: res.last }) : null };
  }
}
