import { Injectable, OnModuleInit } from '@nestjs/common';
import { NOTE_COLORS, NOTE_REF_TYPE, noteSnippet, type RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import { NotesAccessService } from './notes-access.service';
import { noteUrl } from './notes-dto';
import { NOTE_LIST_SELECT } from './notes-dto';
import { DatabaseService } from '../../shared/database/database.service';

/**
 * Карточка заметки в чате (core/rich-cards). Права перепроверяются на КАЖДЫЙ рендер:
 * зритель без доступа видит замороженный минимум — только что это заметка.
 * Действий у карточки нет: заметка открывается по ссылке, а не кнопкой.
 */
@Injectable()
export class NotesRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.registry.registerRenderer(NOTE_REF_TYPE, async (_deps, viewerId, refId) => this.render(viewerId, refId));
  }

  private async render(viewerId: string, noteId: string): Promise<RichCardPayload | null> {
    const note = await this.db.note.findUnique({
      where: { id: noteId },
      select: { ...NOTE_LIST_SELECT, space: { select: { id: true, ownerType: true, ownerId: true } } },
    });
    if (!note) return null;
    const scope = await this.acl.scopeForSpaceId(viewerId, note.spaceId).catch(() => null);
    const access = scope && !note.deletedAt ? this.acl.noteAccess(scope, note) : null;
    if (!access) {
      return {
        kind: 'rich_card',
        cardType: NOTE_REF_TYPE,
        ref: { type: NOTE_REF_TYPE, id: noteId },
        title: this.i18n.translate('notes.noteWord'),
        subtitle: this.i18n.translate('notes.card.noAccess'),
        icon: '📝',
        fields: [],
        status: null,
        actions: [],
        href: null,
      };
    }
    const folder = note.folderId ? await this.db.noteFolder.findUnique({ where: { id: note.folderId }, select: { name: true } }) : null;
    const colorKey = NOTE_COLORS.find((c) => c.value === note.color)?.key;
    return {
      kind: 'rich_card',
      cardType: NOTE_REF_TYPE,
      ref: { type: NOTE_REF_TYPE, id: noteId },
      title: note.title || note.plainText.split('\n')[0]?.slice(0, 80) || this.i18n.translate('notes.untitled'),
      subtitle: noteSnippet(note.plainText, note.title) || null,
      icon: '📝',
      fields: [
        ...(folder ? [{ label: this.i18n.translate('notes.card.folder'), value: folder.name }] : []),
        ...(note.tags.length
          ? [{ label: this.i18n.translate('notes.card.tags'), value: note.tags.map((t) => `#${t}`).join(' ') }]
          : []),
        ...(colorKey ? [{ label: this.i18n.translate('notes.color.label'), value: this.i18n.translate(`notes.color.${colorKey}`) }] : []),
      ],
      status: note.pinnedAt ? this.i18n.translate('notes.card.pinned') : null,
      actions: [],
      href: noteUrl(note.space, noteId),
    };
  }
}
