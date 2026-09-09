import { Injectable, OnModuleInit } from '@nestjs/common';
import { NOTE_FOLDER_REF_TYPE, NOTE_REF_TYPE } from '@superapp/shared';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import { DatabaseService } from '../../shared/database/database.service';
import { PersonalGraphRegistry } from '../contacts/personal-graph.registry';
import { DriveRoutingRegistry } from '../drive/drive-routing.registry';
import { NotesAccessService } from './notes-access.service';
import { NotesShareService } from './notes-share.service';
import { NOTE_FULL_SELECT } from './notes.service';

/**
 * Регистрации сервиса «Заметки» во всех движках — одним файлом (паттерн
 * DocumentsRegistriesProvider): движки про заметки не знают, сервис регистрируется сам.
 */
@Injectable()
export class NotesRegistriesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly share: NotesShareService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly driveRouting: DriveRoutingRegistry,
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly graphHooks: PersonalGraphRegistry,
    private readonly quickActions: QuickActionRegistry,
  ) {}

  onModuleInit(): void {
    // ---- Файлы (картинки в тексте): видит тот, кто видит заметку; прикрепляет — кто правит.
    // scopedPlace: видимость заметки СТРОЖЕ «файла организации» — иначе fileId открывал бы
    // картинку любому сотруднику. Публичные профили сюда не привязываются.
    this.filesRegistry.register(
      NOTE_REF_TYPE,
      {
        canView: (viewerId, noteId) => this.noteAccessAtLeast(viewerId, noteId, 'viewer'),
        canAttach: (userId, noteId) => this.noteAccessAtLeast(userId, noteId, 'editor'),
      },
      { scopedPlace: true, allowedProfiles: ['note_image'] },
    );

    // ---- Картинки заметки попадают на Диск владельца пространства (личный / организации)
    this.driveRouting.register(NOTE_REF_TYPE, {
      resolvePlacement: async (noteId) => {
        const row = await this.db.note.findUnique({
          where: { id: noteId },
          select: { space: { select: { ownerType: true, ownerId: true } } },
        });
        return row ? { ownerType: row.space.ownerType as 'user' | 'workspace', ownerId: row.space.ownerId } : null;
      },
    });

    // ---- Хроника заметки и папки: видит тот, кто видит объект
    this.chatterRegistry.register(NOTE_REF_TYPE, {
      canView: (viewerId, noteId) => this.noteAccessAtLeast(viewerId, noteId, 'viewer'),
    });
    this.chatterRegistry.register(NOTE_FOLDER_REF_TYPE, {
      canView: async (viewerId, folderId) => {
        const folder = await this.db.noteFolder.findUnique({
          where: { id: folderId },
          select: { id: true, spaceId: true, createdById: true, ancestorIds: true },
        });
        if (!folder) return false;
        const scope = await this.acl.scopeForSpaceId(viewerId, folder.spaceId).catch(() => null);
        return !!scope && !!this.acl.folderAccess(scope, folder);
      },
    });

    // ---- Разрыв личной связи = отзыв персональных грантов (правило платформы)
    this.graphHooks.register('notes', { onUnlinked: (a, b) => this.share.revokeBetween(a, b) });

    // ---- Кнопка меню сообщения: текст сообщения — в заметку (форма на клиенте)
    this.quickActions.register({
      key: 'notes.from-message',
      labelKey: 'notes.quickAction.label',
      icon: '📝',
      scopes: ['message'],
      descriptionKey: 'notes.quickAction.description',
    });
  }

  private async noteAccessAtLeast(viewerId: string, noteId: string, need: 'viewer' | 'editor'): Promise<boolean> {
    const note = await this.db.note.findUnique({ where: { id: noteId }, select: NOTE_FULL_SELECT });
    if (!note || note.deletedAt) return false;
    const scope = await this.acl.scopeForSpaceId(viewerId, note.spaceId).catch(() => null);
    if (!scope) return false;
    const access = this.acl.noteAccess(scope, note);
    if (!access) return false;
    return need === 'viewer' || access === 'owner' || access === 'manager' || access === 'editor';
  }
}
