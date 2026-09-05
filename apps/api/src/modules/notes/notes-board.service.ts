import { Injectable, NotFoundException } from '@nestjs/common';
import { NOTE_LIMITS, NOTE_REF_TYPE, noteSnippet, type NoteBoardDto, type NoteBoardItemDto, type NoteBoardPutInput, type NoteBoardQuery, type NoteDoc } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { NotesAccessService, type NoteScope } from './notes-access.service';
import { USER_LITE_SELECT, noteListItem } from './notes-dto';
import { NotesLinksService } from './notes-links.service';
import { NOTE_FULL_SELECT, NotesService } from './notes.service';

/**
 * Доска — ВИД на заметки выбранного раздела, а не отдельный набор: что выбрано слева
 * (папка, все, тег, закреплённые, «поделились», корзина), то и лежит на доске. Личной
 * остаётся РАСКЛАДКА: позиция, размер, слой и свёрнутость карточки (NoteBoardItem на
 * пару человек+заметка). Право на каждую карточку считается по её пространству.
 */
@Injectable()
export class NotesBoardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly links: NotesLinksService,
    private readonly notes: NotesService,
  ) {}

  /**
   * Доска раздела: ВСЕ видимые заметки выбранного набора (папка, все, тег, закреплённые,
   * «поделились со мной», корзина) — тот же фильтр, что у списка. Раскладка (позиция,
   * размер, слой, свёрнутость) хранится на человека и подтягивается к тем заметкам,
   * которые он двигал; остальные раскладываются сеткой по порядку.
   */
  async board(userId: string, q: NoteBoardQuery): Promise<NoteBoardDto> {
    const { scope, rows } = await this.notes.boardRows(userId, q);
    const folderId = q.folderId === 'root' ? null : (q.folderId ?? null);
    if (!rows.length) return { folderId, items: [] };

    const noteIds = rows.map((n) => n.id);
    const [layout, authors, sharedIds, related] = await Promise.all([
      this.db.noteBoardItem.findMany({ where: { userId, noteId: { in: noteIds } } }),
      this.db.user.findMany({ where: { id: { in: [...new Set(rows.map((n) => n.createdById))] } }, select: USER_LITE_SELECT }),
      this.acl.sharedFlags(NOTE_REF_TYPE, noteIds),
      this.links.relatedOf(userId, noteIds),
    ]);
    const layoutByNote = new Map(layout.map((l) => [l.noteId, l]));
    const authorById = new Map(authors.map((a) => [a.id, a]));
    // Слой по умолчанию: неразложенные карточки лежат ВЫШЕ разложенных, а среди них
    // новейшая — выше всех. Иначе новая заметка (первая в порядке, слой 1) рождалась бы
    // под чьей-то разложенной карточкой и её не было видно.
    const maxSavedZ = Math.max(0, ...layout.map((l) => l.z));

    // Заметка может жить в ДРУГОМ пространстве (мне её просто открыли) — право
    // считается по скоупу её пространства, а не доски.
    const scopes = new Map<string, NoteScope>([[scope.space.id, scope]]);
    for (const spaceId of new Set(rows.map((n) => n.spaceId))) {
      if (scopes.has(spaceId)) continue;
      const s = await this.acl.scopeForSpaceId(userId, spaceId).catch(() => null);
      if (s) scopes.set(spaceId, s);
    }

    const out: NoteBoardItemDto[] = [];
    rows.forEach((note, index) => {
      const noteScope = scopes.get(note.spaceId);
      const access = noteScope ? this.acl.noteAccess(noteScope, note) : null;
      if (!access) return;
      const saved = layoutByNote.get(note.id);
      out.push({
        noteId: note.id,
        folderId: note.folderId,
        placed: !!saved,
        x: saved?.x ?? 0,
        y: saved?.y ?? 0,
        w: saved?.w ?? NOTE_LIMITS.stickyDefaultW,
        h: saved?.h ?? NOTE_LIMITS.stickyDefaultH,
        z: saved?.z ?? maxSavedZ + (rows.length - index),
        collapsed: saved?.collapsed ?? false,
        note: {
          ...noteListItem(note, access, sharedIds.has(note.id), authorById.get(note.createdById), noteSnippet(note.plainText, note.title)),
          content: note.content as unknown as NoteDoc,
          version: note.version,
          related: related.get(note.id) ?? [],
        },
      });
    });
    return { folderId, items: out };
  }

  /**
   * Сохранить раскладку заметки на МОЕЙ доске: позиция (пиксели холста от левого
   * верхнего угла), размер, слой, свёрнутость.
   * Строка создаётся при первом перетаскивании — доска показывает заметки раздела и
   * без неё, а эта запись лишь запоминает, куда человек положил карточку.
   */
  async put(userId: string, noteId: string, input: NoteBoardPutInput): Promise<NoteBoardItemDto> {
    const note = await this.db.note.findUnique({ where: { id: noteId }, select: NOTE_FULL_SELECT });
    if (!note) throw new NotFoundException('Заметка не найдена');
    const scope = await this.acl.scopeForSpaceId(userId, note.spaceId);
    const access = this.acl.assertAccess(this.acl.noteAccess(scope, note), 'viewer');
    // Пространство строки — то, где заметка живёт: раскладка привязана к заметке, а
    // не к доске, и переезд заметки между папками её не теряет.
    const existing = await this.db.noteBoardItem.findUnique({ where: { userId_noteId: { userId, noteId } } });
    const data = {
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      ...(input.w !== undefined ? { w: input.w } : {}),
      ...(input.h !== undefined ? { h: input.h } : {}),
      ...(input.z !== undefined ? { z: input.z } : {}),
      ...(input.collapsed !== undefined ? { collapsed: input.collapsed } : {}),
      spaceId: note.spaceId,
      folderId: note.folderId,
    };
    const item = existing
      ? await this.db.noteBoardItem.update({ where: { id: existing.id }, data })
      : await this.db.noteBoardItem.create({
          data: {
            userId,
            spaceId: note.spaceId,
            noteId,
            folderId: note.folderId,
            x: input.x ?? 10,
            y: input.y ?? 10,
            w: input.w ?? NOTE_LIMITS.stickyDefaultW,
            h: input.h ?? NOTE_LIMITS.stickyDefaultH,
            z: input.z ?? 1,
            collapsed: input.collapsed ?? false,
          },
        });
    const author = await this.db.user.findUnique({ where: { id: note.createdById }, select: USER_LITE_SELECT });
    const [sharedIds, related] = await Promise.all([this.acl.sharedFlags(NOTE_REF_TYPE, [note.id]), this.links.relatedOf(userId, [note.id])]);
    return {
      noteId,
      folderId: item.folderId,
      placed: true,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      z: item.z,
      collapsed: item.collapsed,
      note: {
        ...noteListItem(note, access, sharedIds.has(note.id), author, noteSnippet(note.plainText, note.title)),
        content: note.content as unknown as NoteDoc,
        version: note.version,
        related: related.get(note.id) ?? [],
      },
    };
  }
}
