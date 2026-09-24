import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  NOTE_ERROR_CODES,
  NOTE_JOB_TYPES,
  NOTE_FOLDER_REF_TYPE,
  NOTE_LIMITS,
  NOTE_REF_TYPE,
  SOURCE_LOCALE,
  WORKSPACE_ROLE_RANK,
  canonicalNoteJson,
  deriveNoteTitle,
  emptyNoteDoc,
  extractNoteImageFileIds,
  extractNoteMentions,
  extractNoteTags,
  markdownToNoteDoc,
  noteDocToMarkdown,
  noteDocToPlainText,
  noteSnippet,
  validateNoteDoc,
  type CreateNoteInput,
  type CursorPage,
  type NoteAccess,
  type NoteBoardQuery,
  type NoteDetailDto,
  type NoteDoc,
  type NoteListItemDto,
  type NoteListQuery,
  type NoteRevisionDto,
  type NoteSaveResultDto,
  type NoteSidebarDto,
  type NoteSpaceRef,
  type NoteUserLiteDto,
  type NoteRelatedTargetType,
  type NotesByTargetDto,
  type UpdateNoteInput,
} from '@superapp/shared';
import { ChatterService } from '../../core/chatter/chatter.service';
import { FilesService } from '../../core/files/files.service';
import { JobsService } from '../../core/jobs/jobs.service';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { fullName } from '../../shared/utils/user-name';
import { MentionsService } from '../messenger/mentions.service';
import { NotesAccessService, type NoteScope } from './notes-access.service';
import { NOTE_LIST_SELECT, USER_LITE_SELECT, noteListItem, noteUrl, userLite, type NoteListRow, type UserLiteRow } from './notes-dto';
import { NotesFoldersService } from './notes-folders.service';
import { NotesLinksService } from './notes-links.service';
import { NotesSearchService } from './notes-search.service';
import { NoteTargetRegistry } from './notes-targets.registry';
import { decodeCursor as decodeKeyset, encodeCursor as encodeKeyset } from '@superapp/shared';

type Tx = Prisma.TransactionClient;

/** Заметка целиком (детальная карточка, сохранение) */
const NOTE_FULL_SELECT = {
  ...NOTE_LIST_SELECT,
  content: true,
  contentMd: true,
  contentHash: true,
} satisfies Prisma.NoteSelect;
type NoteFullRow = Prisma.NoteGetPayload<{ select: typeof NOTE_FULL_SELECT }>;

interface Projection {
  doc: NoteDoc;
  /** Название = ПЕРВАЯ СТРОКА документа: отдельного поля ввода у заметки нет */
  title: string;
  contentMd: string;
  plainText: string;
  tags: string[];
  contentHash: string;
}

/**
 * Заметки: пространства, список, карточка, сохранение с проекциями.
 *
 * Сохранение — ОДНА транзакция: проверка документа (fail-closed) → JSON-канон +
 * Markdown + чистый текст + теги + хеш → версия и снимок → вики-ссылки → джоб
 * проекций (чанки). Упоминания и витрина поиска — сразу после коммита, best-effort.
 * Оптимистическая блокировка `version`: правка от устаревшей версии = 409, а не
 * молчаливое затирание чужого текста.
 */
@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly folders: NotesFoldersService,
    private readonly links: NotesLinksService,
    private readonly search: NotesSearchService,
    private readonly chatter: ChatterService,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly mentions: MentionsService,
    private readonly targets: NoteTargetRegistry,
    private readonly i18n: I18nService,
  ) {}

  /** Снимок для БД — в языке ИСТОЧНИКА (зритель перерисует его при чтении). */
  private src(key: string): string {
    return this.i18n.translateFor(SOURCE_LOCALE, key);
  }

  // ============================================================
  // Левая панель
  // ============================================================

  async sidebar(userId: string, ref: NoteSpaceRef): Promise<NoteSidebarDto> {
    const scope = await this.acl.scopeFor(userId, ref);
    const [folders, foreignFolders, counts, sharedNotesCount, rootNotesCount, trashCount, tags, spaceTitle] = await Promise.all([
      this.folders.listVisible(scope),
      this.folders.listForeign(scope),
      this.folders.countNotesByFolder(scope),
      // «Поделились со мной» считает и чужие пространства — личный шеринг живёт там
      this.db.note.count({ where: { AND: [this.acl.sharedNotesWhere(scope), { deletedAt: null }] } }),
      this.db.note.count({ where: { ...this.acl.visibleNotesWhere(scope), deletedAt: null, folderId: null } }),
      this.db.note.count({ where: { ...this.acl.visibleNotesWhere(scope), deletedAt: { not: null } } }),
      this.tagCounts(scope),
      this.spaceTitle(scope),
    ]);
    const foreignCounts = await this.folders.countNotesInForeignFolders(scope, foreignFolders.map((f) => f.id));
    const mine = folders.filter((f) => f.createdById === userId || scope.spaceAccess === 'owner');
    const shared = folders.filter((f) => !(f.createdById === userId || scope.spaceAccess === 'owner'));
    const toDto = (f: (typeof folders)[number]) =>
      this.folders.toDto(f, this.acl.folderAccess(scope, f) ?? 'viewer', counts.get(f.id) ?? 0);
    // Папка чужого пространства: право — только грант, счётчик — по «поделились со мной»
    const foreignToDto = (f: (typeof foreignFolders)[number]) =>
      this.folders.toDto(f, this.acl.foreignFolderAccess(scope, f) ?? 'viewer', foreignCounts.get(f.id) ?? 0);
    return {
      space: {
        id: scope.space.id,
        ownerType: scope.space.ownerType as 'user' | 'workspace',
        ownerId: scope.space.ownerId,
        title: spaceTitle,
        access: scope.spaceAccess ?? (scope.member ? 'editor' : 'viewer'),
      },
      folders: mine.map(toDto),
      sharedFolders: [...shared.map(toDto), ...foreignFolders.map(foreignToDto)],
      sharedNotesCount,
      rootNotesCount,
      tags,
      trashCount,
    };
  }

  private async spaceTitle(scope: NoteScope): Promise<string> {
    if (scope.space.ownerType === 'user') return this.i18n.translate('notes.space.personal');
    const ws = await this.db.workspace.findUnique({ where: { id: scope.space.ownerId }, select: { name: true } });
    return ws?.name ?? this.i18n.translate('notes.space.org');
  }

  /** Теги пространства с количеством — раскладка массива в SQL под предикатом видимости */
  private async tagCounts(scope: NoteScope): Promise<Array<{ name: string; count: number }>> {
    const visible = this.acl.visibilitySql(
      'n',
      scope.spaceAccess === 'owner' ? [scope.space.id] : [],
      scope.member && scope.spaceAccess !== 'owner' ? [scope.space.id] : [],
      scope.userId,
      scope.grants,
    );
    const rows = await this.db.$queryRaw<Array<{ name: string; count: bigint }>>(Prisma.sql`
      SELECT t AS "name", COUNT(*)::bigint AS "count"
        FROM "notes" n, unnest(n."tags") AS t
       WHERE n."space_id" = ${scope.space.id}::uuid AND n."deleted_at" IS NULL AND ${visible}
       GROUP BY t
       ORDER BY COUNT(*) DESC, t ASC
       LIMIT 200`);
    return rows.map((r) => ({ name: r.name, count: Number(r.count) }));
  }

  // ============================================================
  // Список
  // ============================================================

  /**
   * Скоуп и условие выборки раздела — ОДНО на список и на доску: они показывают один и
   * тот же набор заметок, просто по-разному. Разъедься эти условия — и доска молча
   * покажет не то, что дерево слева.
   */
  private async sectionQuery(
    userId: string,
    q: { workspaceId?: string; folderId?: string; tag?: string; pinned?: boolean; shared?: boolean; trashed?: boolean; q?: string },
  ): Promise<{ scope: NoteScope; and: Prisma.NoteWhereInput[] }> {
    let scope = await this.acl.scopeFor(userId, { workspaceId: q.workspaceId });
    // Папка, открытая мне в ЧУЖОМ пространстве, приходит тем же параметром — скоуп берём
    // от неё, иначе список молча вернул бы пусто (условие видимости скоуплено пространством).
    if (q.folderId && q.folderId !== 'root') {
      const folderSpaceId = await this.folders.spaceIdOf(q.folderId);
      if (folderSpaceId !== scope.space.id) scope = await this.acl.scopeForSpaceId(userId, folderSpaceId);
    }
    const and: Prisma.NoteWhereInput[] = [q.shared ? this.acl.sharedNotesWhere(scope) : this.acl.visibleNotesWhere(scope)];
    and.push(q.trashed ? { deletedAt: { not: null } } : { deletedAt: null });
    if (q.folderId === 'root') and.push({ folderId: null });
    else if (q.folderId) and.push({ folderId: q.folderId });
    if (q.tag) and.push({ tags: { has: q.tag.toLowerCase() } });
    if (q.pinned) and.push({ pinnedAt: { not: null } });
    if (q.q) {
      and.push({
        OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { plainText: { contains: q.q, mode: 'insensitive' } }],
      });
    }
    return { scope, and };
  }

  /** Заметки раздела для доски: те же фильтры, весь набор целиком (потолок — boardMaxItems) */
  async boardRows(userId: string, q: NoteBoardQuery): Promise<{ scope: NoteScope; rows: NoteFullRow[] }> {
    const { scope, and } = await this.sectionQuery(userId, q);
    const rows = await this.db.note.findMany({
      where: { AND: and },
      select: NOTE_FULL_SELECT,
      // Порядок доски — по СОЗДАНИЮ, а не по правке (в отличие от списка): сетка карточек
      // держит слоты по этому порядку, и правка текста не должна переставлять карточки.
      orderBy: q.trashed
        ? [{ deletedAt: 'desc' }, { id: 'desc' }]
        : [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      take: NOTE_LIMITS.boardMaxItems,
    });
    return { scope, rows };
  }

  async list(userId: string, q: NoteListQuery): Promise<CursorPage<NoteListItemDto>> {
    const { scope, and } = await this.sectionQuery(userId, q);
    const limit = Math.min(q.limit ?? NOTE_LIMITS.listPageSize, 100);
    // Keyset СВОИМ условием, а не `cursor` Prisma: при `nulls: 'last'` Prisma вставляет
    // «ИЛИ курсорное поле NULL», и страница за незакреплённой заметкой снова приносит
    // закреплённые — они уже были на первой. Ключ — весь порядок сортировки целиком.
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    if (after) and.push(keysetWhere(after, !!q.trashed));
    const rows = await this.db.note.findMany({
      where: { AND: and },
      select: NOTE_LIST_SELECT,
      orderBy: q.trashed
        ? [{ deletedAt: 'desc' }, { id: 'desc' }]
        : [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Страница «Поделились со мной» приходит из разных пространств — права на каждое своё
    const items = await this.listItemsAcrossSpaces(userId, scope, page);
    return { items, nextCursor: hasMore ? this.cursorOf(page[page.length - 1], !!q.trashed) : null };
  }

  /** Заметки, привязанные к сущности (панель на карточке): право на сущность решает модуль-цель */
  async listByTarget(userId: string, targetType: string, targetId: string): Promise<NotesByTargetDto> {
    const resolver = this.targets.get(targetType);
    if (!resolver) throw badRequest('notes.unknownEntity');
    // describe отдаёт null там же, где canView вернул бы false — один поход в модуль-цель
    const described = await resolver.describe(userId, targetId);
    if (!described) throw notFound('notes.entityNotFound');
    const canAttach = await this.canWriteIn(userId, described.workspaceId);
    const ids = await this.links.noteIdsByTarget(targetType, targetId);
    if (!ids.length) return { items: [], canAttach };
    const rows = await this.db.note.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: NOTE_LIST_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: NOTE_LIMITS.byTargetLimit,
    });
    // Заметки о сущности живут в разных пространствах (личные и рабочие) — скоуп на каждое.
    const base = await this.acl.scopeFor(userId, {});
    const items = await this.listItemsAcrossSpaces(userId, base, rows);
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { items, canAttach };
  }

  /**
   * Может ли зритель завести заметку в пространстве этой сущности: в организации —
   * только член команды (Подрядчик изолирован), в личном — всегда. Панель сущности
   * не должна предлагать кнопку, на которую сервер ответит отказом.
   */
  private async canWriteIn(userId: string, workspaceId: string | null): Promise<boolean> {
    if (!workspaceId) return true;
    return (await this.acl.workspaceRank(userId, workspaceId)) >= WORKSPACE_ROLE_RANK.trainee;
  }

  /** Строки → DTO списка: права/автор/«поделились» батчами, невидимые строки отбрасываются */
  async listItems(scope: NoteScope, rows: NoteListRow[]): Promise<NoteListItemDto[]> {
    return this.listItemsWith(new Map([[scope.space.id, scope]]), rows);
  }

  /**
   * То же, но строки могут быть из разных пространств (раздел «Поделились со мной»,
   * панель сущности): скоуп на каждое пространство считается один раз.
   */
  async listItemsAcrossSpaces(userId: string, base: NoteScope, rows: NoteListRow[]): Promise<NoteListItemDto[]> {
    const scopes = new Map<string, NoteScope>([[base.space.id, base]]);
    for (const spaceId of new Set(rows.map((r) => r.spaceId))) {
      if (scopes.has(spaceId)) continue;
      const scope = await this.acl.scopeForSpaceId(userId, spaceId).catch(() => null);
      if (scope) scopes.set(spaceId, scope);
    }
    return this.listItemsWith(scopes, rows);
  }

  private async listItemsWith(scopes: Map<string, NoteScope>, rows: NoteListRow[]): Promise<NoteListItemDto[]> {
    if (!rows.length) return [];
    const [authors, sharedIds] = await Promise.all([
      this.usersLite(rows.map((r) => r.createdById)),
      this.acl.sharedFlags(NOTE_REF_TYPE, rows.map((r) => r.id)),
    ]);
    const out: NoteListItemDto[] = [];
    for (const row of rows) {
      const scope = scopes.get(row.spaceId);
      const access = scope ? this.acl.noteAccess(scope, row) : null;
      if (!access) continue;
      out.push(
        noteListItem(
          row,
          access,
          sharedIds.has(row.id),
          authors.get(row.createdById),
          this.snippetOf(row),
          this.i18n.translate('common.labels.someone'),
        ),
      );
    }
    return out;
  }

  /** Курсор keyset: весь ключ сортировки, а не только id (см. list) */
  private cursorOf(row: NoteListRow, trashed: boolean): string {
    return encodeCursor(
      trashed
        ? { trashed: true, at: (row.deletedAt ?? row.updatedAt).toISOString(), id: row.id }
        : { trashed: false, pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null, at: row.updatedAt.toISOString(), id: row.id },
    );
  }

  private snippetOf(row: { title: string; plainText: string }): string {
    return noteSnippet(row.plainText, row.title);
  }

  private async usersLite(ids: string[]): Promise<Map<string, UserLiteRow>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = await this.db.user.findMany({ where: { id: { in: uniq } }, select: USER_LITE_SELECT });
    return new Map(rows.map((u) => [u.id, u]));
  }

  // ============================================================
  // Карточка
  // ============================================================

  /** Заметка по id с проверкой права: чужое = 404 */
  async requireNote(userId: string, noteId: string, need: 'viewer' | 'editor' | 'manager'): Promise<{ note: NoteFullRow; scope: NoteScope; access: NoteAccess }> {
    const note = await this.db.note.findUnique({ where: { id: noteId }, select: NOTE_FULL_SELECT });
    if (!note) throw notFound('notes.noteNotFound');
    const scope = await this.acl.scopeForSpaceId(userId, note.spaceId);
    const access = this.acl.assertAccess(this.acl.noteAccess(scope, note), need);
    return { note, scope, access };
  }

  async get(userId: string, noteId: string): Promise<NoteDetailDto> {
    const { note, scope, access } = await this.requireNote(userId, noteId, 'viewer');
    return this.detail(scope, note, access);
  }

  async detail(scope: NoteScope, note: NoteFullRow, access: NoteAccess): Promise<NoteDetailDto> {
    const doc = note.content as unknown as NoteDoc;
    const [authors, sharedIds, crumbs, related, backlinks, mentionsWithoutAccess] = await Promise.all([
      this.usersLite([note.createdById]),
      this.acl.sharedFlags(NOTE_REF_TYPE, [note.id]),
      this.folders.crumbs(scope, note.folderId),
      this.links.relatedOf(scope.userId, [note.id]),
      this.links.backlinks(scope, note.id),
      this.mentionsWithoutAccess(note, doc),
    ]);
    return {
      ...noteListItem(
        note,
        access,
        sharedIds.has(note.id),
        authors.get(note.createdById),
        this.snippetOf(note),
        this.i18n.translate('common.labels.someone'),
      ),
      spaceId: note.spaceId,
      ownerType: scope.space.ownerType as 'user' | 'workspace',
      ownerId: scope.space.ownerId,
      content: doc,
      contentMd: note.contentMd,
      version: note.version,
      folderPath: crumbs,
      related: related.get(note.id) ?? [],
      backlinks,
      mentionsWithoutAccess,
    };
  }

  /** Упомянутые, которые заметку НЕ видят (подсказка «поделиться с упомянутыми») */
  async mentionsWithoutAccess(note: NoteListRow, doc: NoteDoc): Promise<NoteUserLiteDto[]> {
    const mentioned = extractNoteMentions(doc).filter((m) => m.userId !== note.createdById);
    if (!mentioned.length) return [];
    const out: string[] = [];
    for (const m of mentioned) if (!(await this.canUserView(m.userId, note))) out.push(m.userId);
    if (!out.length) return [];
    const users = await this.usersLite(out);
    return out.map((id) => userLite(users.get(id), id, this.i18n.translate('common.labels.someone')));
  }

  /** Видит ли ДРУГОЙ человек заметку (гранты + членство + авторство) */
  async canUserView(userId: string, note: { id: string; spaceId: string; createdById: string; folderPath: string[] }): Promise<boolean> {
    try {
      const scope = await this.acl.scopeForSpaceId(userId, note.spaceId);
      return !!this.acl.noteAccess(scope, note);
    } catch {
      return false;
    }
  }

  // ============================================================
  // Создание и сохранение
  // ============================================================

  async create(userId: string, input: CreateNoteInput): Promise<NoteDetailDto> {
    const scope = await this.acl.scopeFor(userId, { workspaceId: input.workspaceId });
    let folderPath: string[] = [];
    if (input.folderId) {
      const { folder } = await this.folders.requireFolder(scope, input.folderId, 'editor');
      folderPath = [folder.id, ...folder.ancestorIds];
    } else if (!scope.member) {
      throw forbidden('notes.cannotCreateHere');
    }
    const doc = input.content ?? (input.markdown !== undefined ? markdownToNoteDoc(input.markdown) : emptyNoteDoc());
    const proj = this.project(doc);
    await this.assertImagesAllowed(userId, null, proj.doc);
    const related = input.related ?? [];
    for (const r of related) await this.links.requireTarget(userId, scope, r.targetType, r.targetId);

    const created = await this.db.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          spaceId: scope.space.id,
          folderId: input.folderId ?? null,
          folderPath,
          title: proj.title,
          content: proj.doc as unknown as Prisma.InputJsonValue,
          contentMd: proj.contentMd,
          plainText: proj.plainText,
          contentHash: proj.contentHash,
          tags: proj.tags,
          color: input.color ?? null,
          createdById: userId,
          updatedById: userId,
        },
        select: NOTE_FULL_SELECT,
      });
      await tx.noteRevision.create({
        data: { noteId: note.id, version: 1, content: proj.doc as unknown as Prisma.InputJsonValue, createdById: userId },
      });
      await this.links.syncWikilinks(tx, note.id, proj.doc, userId);
      for (const r of related) await this.links.addRelated(tx, note.id, r.targetType, r.targetId, userId);
      await this.enqueueProjection(tx, note);
      await this.log(tx, scope, note.id, 'note.created', { ...this.logTitle(note) });
      return note;
    });

    this.afterSave(scope, created, proj.doc).catch((e) => this.logger.warn(`afterSave ${created.id}: ${String(e)}`));
    return this.detail(scope, created, 'manager');
  }

  async update(userId: string, noteId: string, input: UpdateNoteInput): Promise<NoteSaveResultDto> {
    const { note, scope } = await this.requireNote(userId, noteId, 'editor');
    if (note.deletedAt) throw badRequest('notes.inTrash');

    // Перенос: только внутри того же пространства, целевая папка — с правом правки
    let folderChange: { folderId: string | null; folderPath: string[]; toName: string } | null = null;
    if (input.folderId !== undefined && input.folderId !== note.folderId) {
      if (input.folderId) {
        const { folder } = await this.folders.requireFolder(scope, input.folderId, 'editor');
        folderChange = { folderId: folder.id, folderPath: [folder.id, ...folder.ancestorIds], toName: folder.name };
      } else {
        if (!scope.member) throw forbidden('notes.toRootMemberOnly');
        folderChange = { folderId: null, folderPath: [], toName: this.src('notes.rootName') };
      }
    }

    const doc: NoteDoc | null = input.content ?? (input.markdown !== undefined ? markdownToNoteDoc(input.markdown) : null);
    const proj = doc ? this.project(doc) : null;
    const contentChanged = !!proj && proj.contentHash !== note.contentHash;
    if (contentChanged && proj) await this.assertImagesAllowed(userId, noteId, proj.doc);
    const previousDoc = note.content as unknown as NoteDoc;

    const saved = await this.db.$transaction(async (tx) => {
      const data: Prisma.NoteUncheckedUpdateManyInput = { updatedById: userId, version: { increment: 1 } };
      if (input.color !== undefined) data.color = input.color;
      if (input.pinned !== undefined) data.pinnedAt = input.pinned ? new Date() : null;
      if (folderChange) {
        data.folderId = folderChange.folderId;
        data.folderPath = folderChange.folderPath;
      }
      if (contentChanged && proj) {
        data.content = proj.doc as unknown as Prisma.InputJsonValue;
        data.contentMd = proj.contentMd;
        data.plainText = proj.plainText;
        data.contentHash = proj.contentHash;
        data.tags = proj.tags;
        // Название едет вместе с текстом: это первая строка, а не отдельное поле
        data.title = proj.title;
      }
      // Status-guarded UPDATE по версии: 0 строк = кто-то сохранил раньше нас.
      const res = await tx.note.updateMany({ where: { id: noteId, version: input.baseVersion, deletedAt: null }, data });
      if (res.count === 0) {
        throw conflict('notes.versionConflict', undefined, { code: NOTE_ERROR_CODES.versionConflict });
      }
      const fresh = await tx.note.findUniqueOrThrow({ where: { id: noteId }, select: NOTE_FULL_SELECT });
      if (contentChanged && proj) {
        await tx.noteRevision.create({
          data: { noteId, version: fresh.version, content: proj.doc as unknown as Prisma.InputJsonValue, createdById: userId },
        });
        await this.trimRevisions(tx, noteId);
        await this.links.syncWikilinks(tx, noteId, proj.doc, userId);
      }
      // Витрина поиска зависит и от заголовка — джоб ставим на любое сохранение
      await this.enqueueProjection(tx, fresh);
      if (fresh.title !== note.title) {
        await this.log(tx, scope, noteId, 'note.renamed', { ...this.logTitle(fresh) }, [
          { field: 'title', label: this.src('chatter.fields.note.title'), from: note.title || null, to: fresh.title || null },
        ]);
      }
      if (folderChange) {
        await this.log(tx, scope, noteId, 'note.moved', { ...this.logTitle(fresh), to: folderChange.toName });
      }
      return fresh;
    });

    const known = new Set(extractNoteMentions(previousDoc).map((m) => m.userId));
    const after = await this.afterSave(scope, saved, proj?.doc ?? previousDoc, known).catch((e) => {
      this.logger.warn(`afterSave ${noteId}: ${String(e)}`);
      return { hints: [] as NoteUserLiteDto[], checked: false };
    });
    return {
      id: saved.id,
      version: saved.version,
      title: saved.title,
      snippet: this.snippetOf(saved),
      tags: saved.tags,
      updatedAt: saved.updatedAt.toISOString(),
      mentionsWithoutAccess: after.hints,
      // false — набор упоминаний не менялся, доступ не пересчитывали: клиент
      // оставляет подсказку, которая у него уже есть, а не гасит её пустым списком
      mentionsChecked: after.checked,
    };
  }

  /**
   * Картинки документа обязаны быть файлами, к которым у автора есть право: свои
   * (загружены им) или уже привязанные к этой заметке (загрузил соредактор). Чужой
   * fileId в JSON — отказ до записи (fail-closed), иначе знание id открывало бы файл.
   */
  private async assertImagesAllowed(userId: string, noteId: string | null, doc: NoteDoc): Promise<void> {
    const ids = extractNoteImageFileIds(doc);
    if (!ids.length) return;
    const linked = noteId ? new Set(await this.files.getLinkedFileIds(NOTE_REF_TYPE, noteId)) : new Set<string>();
    const unknown = ids.filter((id) => !linked.has(id));
    if (!unknown.length) return;
    const owned = new Set((await this.files.getOwnedReadyFiles(userId, unknown)).map((f) => f.id));
    const bad = unknown.filter((id) => !owned.has(id));
    if (bad.length) throw badRequest('notes.imageNotYours');
  }

  /** Связи файлов = картинки в документе: новые привязать (право = editor), исчезнувшие отвязать */
  private async syncImageLinks(userId: string, noteId: string, doc: NoteDoc): Promise<void> {
    const wanted = new Set(extractNoteImageFileIds(doc));
    const linked = new Set(await this.files.getLinkedFileIds(NOTE_REF_TYPE, noteId));
    for (const fileId of wanted) {
      if (linked.has(fileId)) continue;
      await this.files.linkFile(userId, fileId, NOTE_REF_TYPE, noteId).catch((e) => this.logger.warn(`link ${fileId}→${noteId}: ${String(e)}`));
    }
    for (const fileId of linked) {
      if (wanted.has(fileId)) continue;
      await this.files.unlinkAndReap(userId, fileId, NOTE_REF_TYPE, noteId).catch((e) => this.logger.warn(`unlink ${fileId}→${noteId}: ${String(e)}`));
    }
  }

  /**
   * После коммита: связи картинок + витрина поиска + упоминания (только тем, кто видит).
   *
   * `knownMentions` — набор упоминаний прошлой версии документа: если он не изменился,
   * проверять доступ заново не нужно. Автосохранение зовёт эту дорогу каждые 800 мс, а
   * проверка «видит ли» — это роли + гранты на КАЖДОГО упомянутого.
   */
  private async afterSave(
    scope: NoteScope,
    note: NoteFullRow,
    doc: NoteDoc,
    knownMentions?: Set<string>,
  ): Promise<{ hints: NoteUserLiteDto[]; checked: boolean }> {
    await this.syncImageLinks(scope.userId, note.id, doc);
    await this.search.index({ ...note, ownerType: scope.space.ownerType, ownerId: scope.space.ownerId });
    const mentioned = extractNoteMentions(doc).filter((m) => m.userId !== scope.userId);
    if (!mentioned.length) return { hints: [], checked: true };
    // Набор упоминаний не изменился И все упомянутые уже записаны в Mentions Hub —
    // значит доступ у них был, нового ничего не появится, и N проверок прав (роли +
    // гранты на каждого) при автосохранении каждые 800 мс не нужны. Если хоть один
    // НЕ записан, идём полным путём: ему могли только что открыть доступ.
    if (knownMentions && mentioned.length === knownMentions.size && mentioned.every((m) => knownMentions.has(m.userId))) {
      const recorded = await this.mentions.recordedMentionees('note', note.id, mentioned.map((m) => m.userId));
      if (mentioned.every((m) => recorded.has(m.userId))) return { hints: [], checked: false };
    }
    const withAccess: string[] = [];
    const without: string[] = [];
    for (const m of mentioned) (await this.canUserView(m.userId, note)) ? withAccess.push(m.userId) : without.push(m.userId);
    // Дедуп — по уже ЗАПИСАННЫМ упоминаниям (MentionsService), а не по прошлому документу:
    // человек, упомянутый до выдачи доступа, получает запись при первом сохранении ПОСЛЕ шеринга.
    if (withAccess.length) {
      await this.mentions.recordMentions({
        sourceType: 'note',
        sourceId: note.id,
        mentionerUserId: scope.userId,
        mentionedUserIds: withAccess,
        snippet: this.ownTitle(note) || this.i18n.translate('notes.untitled'),
        actionUrl: noteUrl(scope.space, note.id),
        workspaceId: scope.space.ownerType === 'workspace' ? scope.space.ownerId : null,
      });
    }
    if (!without.length) return { hints: [], checked: true };
    const users = await this.usersLite(without);
    return {
      hints: without.map((id) => userLite(users.get(id), id, this.i18n.translate('common.labels.someone'))),
      checked: true,
    };
  }

  /** Заголовок для показа: явный, иначе из документа. Язык — ЗАПРОСА (render-at-read). */
  displayTitle(note: { title: string; content?: unknown; plainText: string }): string {
    return this.ownTitle(note) || this.i18n.translate('notes.untitled');
  }

  /** Собственное название заметки: явное, из документа или первая строка. Пусто — значит его нет. */
  private ownTitle(note: { title: string; content?: unknown; plainText: string }): string {
    if (note.title) return note.title;
    if (note.content) return deriveNoteTitle(note.content as unknown as NoteDoc, '');
    return note.plainText.split('\n')[0]?.slice(0, 80) || '';
  }

  /**
   * Имя заметки для ВЕЧНОЙ записи (payload хроники). Названия нет — кладём КЛЮЧ
   * каталога, а не слово: слово застыло бы в языке того, кто нажал кнопку, и
   * казахский читатель видел бы «Без названия» посреди своей фразы.
   * `resolveLabelKeys` подставит перевод под именем БЕЗ суффикса при чтении.
   */
  logTitle(note: { title: string; content?: unknown; plainText: string }, as = 'targetName'): Record<string, string> {
    const own = this.ownTitle(note);
    return own ? { [as]: own } : { [`${as}Key`]: 'notes.untitled' };
  }

  private project(doc: NoteDoc): Projection {
    const v = validateNoteDoc(doc);
    if (!v.ok) throw badRequest(v.reason);
    const canonical = canonicalNoteJson(doc);
    return {
      doc: JSON.parse(canonical) as NoteDoc,
      // Название — такая же производная от документа, как Markdown и теги: отдельного
      // поля ввода нет, человек правит первую строку прямо в тексте (модель Apple Notes).
      title: deriveNoteTitle(doc, '').slice(0, NOTE_LIMITS.maxTitleLength),
      contentMd: noteDocToMarkdown(doc),
      plainText: noteDocToPlainText(doc),
      tags: extractNoteTags(doc),
      contentHash: createHash('sha256').update(canonical).digest('hex'),
    };
  }

  /**
   * Джоб проекций — на КАЖДУЮ мутацию, влияющую на витрину поиска или чанки
   * (текст, заголовок, корзина, восстановление). Ключ — версия и состояние корзины:
   * по одному хешу содержимого переименование не проходило бы дедуп, и витрина
   * оставалась бы со старым заголовком.
   */
  private async enqueueProjection(tx: Tx, note: { id: string; version: number; contentHash: string; deletedAt: Date | null }): Promise<void> {
    const state = note.deletedAt ? 'trashed' : 'live';
    await this.jobs.enqueue(tx, {
      type: NOTE_JOB_TYPES.project,
      payload: { noteId: note.id, contentHash: note.contentHash, version: note.version },
      uniqueKey: `${NOTE_JOB_TYPES.project}:${note.id}:${note.version}:${state}`,
    });
  }

  private async trimRevisions(tx: Tx, noteId: string): Promise<void> {
    const extra = await tx.noteRevision.findMany({
      where: { noteId },
      orderBy: { version: 'desc' },
      skip: NOTE_LIMITS.revisionsKeep,
      select: { id: true },
    });
    if (extra.length) await tx.noteRevision.deleteMany({ where: { id: { in: extra.map((r) => r.id) } } });
  }

  // ============================================================
  // История версий
  // ============================================================

  /** Снимки заметки: что и когда сохраняли (кап — NOTE_LIMITS.revisionsKeep) */
  async revisions(userId: string, noteId: string): Promise<NoteRevisionDto[]> {
    const { note } = await this.requireNote(userId, noteId, 'viewer');
    const rows = await this.db.noteRevision.findMany({
      where: { noteId: note.id },
      orderBy: { version: 'desc' },
      take: NOTE_LIMITS.revisionsKeep,
      select: { version: true, createdById: true, createdAt: true, content: true },
    });
    const authors = await this.usersLite(rows.map((r) => r.createdById));
    return rows.map((r) => ({
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      author: userLite(authors.get(r.createdById), r.createdById, this.i18n.translate('common.labels.someone')),
      current: r.version === note.version,
      preview: noteSnippet(noteDocToPlainText(r.content as unknown as NoteDoc), ''),
    }));
  }

  /** Содержимое конкретного снимка (предпросмотр перед откатом) */
  async revision(userId: string, noteId: string, version: number): Promise<NoteDoc> {
    await this.requireNote(userId, noteId, 'viewer');
    const row = await this.db.noteRevision.findUnique({ where: { noteId_version: { noteId, version } }, select: { content: true } });
    if (!row) throw notFound('notes.revisionNotFound');
    return row.content as unknown as NoteDoc;
  }

  /**
   * Откатить заметку к снимку. Это обычное сохранение поверх текущей версии, а не
   * подмена истории: старый текст возвращается НОВОЙ версией, и откат сам попадает
   * в историю (модель Google Docs).
   */
  async restoreRevision(userId: string, noteId: string, version: number): Promise<NoteSaveResultDto> {
    const { note } = await this.requireNote(userId, noteId, 'editor');
    const row = await this.db.noteRevision.findUnique({ where: { noteId_version: { noteId, version } }, select: { content: true } });
    if (!row) throw notFound('notes.revisionNotFound');
    return this.update(userId, noteId, { baseVersion: note.version, content: row.content as unknown as NoteDoc });
  }

  // ============================================================
  // Корзина
  // ============================================================

  async trash(userId: string, noteId: string): Promise<void> {
    const { note, scope } = await this.requireNote(userId, noteId, 'manager');
    if (note.deletedAt) return;
    await this.db.$transaction(async (tx) => {
      await tx.note.updateMany({ where: { id: noteId, deletedAt: null }, data: { deletedAt: new Date() } });
      await this.enqueueProjection(tx, { ...note, deletedAt: new Date() });
      await this.log(tx, scope, noteId, 'note.trashed', { ...this.logTitle(note) });
    });
    await this.search.remove(noteId);
  }

  async restore(userId: string, noteId: string): Promise<NoteDetailDto> {
    const { note, scope, access } = await this.requireNote(userId, noteId, 'manager');
    if (!note.deletedAt) return this.detail(scope, note, access);
    const folderAlive = note.folderId
      ? await this.db.noteFolder.findFirst({ where: { id: note.folderId, deletedAt: null }, select: { id: true } })
      : null;
    const restored = await this.db.$transaction(async (tx) => {
      const fresh = await tx.note.update({
        where: { id: noteId },
        // Папка в корзине или удалена — заметка поднимается в корень
        data: note.folderId && !folderAlive ? { deletedAt: null, folderId: null, folderPath: [] } : { deletedAt: null },
        select: NOTE_FULL_SELECT,
      });
      await this.enqueueProjection(tx, fresh);
      await this.log(tx, scope, noteId, 'note.restored', { ...this.logTitle(fresh) });
      return fresh;
    });
    await this.search.index({ ...restored, ownerType: scope.space.ownerType, ownerId: scope.space.ownerId });
    return this.detail(scope, restored, access);
  }

  /** Удалить навсегда (только из корзины) */
  async purge(userId: string, noteId: string): Promise<void> {
    const { note } = await this.requireNote(userId, noteId, 'manager');
    if (!note.deletedAt) throw badRequest('notes.trashFirst');
    await this.hardDelete([noteId]);
  }

  /**
   * Пачка корзины (шаг `notes.trash` раннера сроков core/lifecycle): заметки, удалённые
   * раньше `before`, keyset (deletedAt, id); удерживаемые заморозкой пропускаются.
   */
  async purgeTrashBatch(opts: {
    before: Date;
    limit: number;
    cursor: string | null;
    releasable: (tx: Prisma.TransactionClient, ids: readonly string[]) => Promise<string[]>;
  }): Promise<{ rows: number; more: boolean; cursor: string | null }> {
    const take = Math.min(opts.limit, NOTE_LIMITS.purgeBatch);
    const c = decodeKeyset(opts.cursor, TRASH_CURSOR);
    const rows = await this.db.note.findMany({
      where: { deletedAt: { lt: opts.before }, ...(c ? { OR: [{ deletedAt: { gt: c.d } }, { deletedAt: c.d, id: { gt: c.i } }] } : {}) },
      select: { id: true, deletedAt: true },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      take,
    });
    if (!rows.length) return { rows: 0, more: false, cursor: null };
    const ok = await this.db.$transaction((tx) => opts.releasable(tx, rows.map((r) => r.id)));
    if (ok.length) await this.hardDelete(ok);
    const last = rows[rows.length - 1]!;
    return { rows: ok.length, more: rows.length === take, cursor: encodeKeyset({ d: last.deletedAt, i: last.id }) };
  }

  /**
   * Каскад окончательного удаления организации: её пространство заметок уходит целиком —
   * заметки тем же путём, что «удалить навсегда» (привязки файлов, гранты, строки,
   * индекс), гранты папок, затем строка пространства (папки, доску и чанки снимет внешний
   * ключ). Пачками, идемпотентно: прерванный прогон доберёт остаток.
   */
  async purgeSpaceOf(ownerType: 'workspace', ownerId: string, deadline: number | null = null): Promise<{ rows: number; done: boolean }> {
    const space = await this.db.noteSpace.findUnique({
      where: { ownerType_ownerId: { ownerType, ownerId } },
      select: { id: true },
    });
    if (!space) return { rows: 0, done: true };
    let removed = 0;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return { rows: removed, done: false };
      const rows = await this.db.note.findMany({ where: { spaceId: space.id }, select: { id: true }, take: NOTE_LIMITS.purgeBatch });
      if (!rows.length) break;
      await this.hardDelete(rows.map((r) => r.id));
      removed += rows.length;
    }
    const folders = await this.db.noteFolder.findMany({ where: { spaceId: space.id }, select: { id: true } });
    await this.db.$transaction(async (tx) => {
      for (const f of folders) await this.acl.revokeAll(NOTE_FOLDER_REF_TYPE, f.id, tx);
      await tx.noteSpace.delete({ where: { id: space.id } });
    });
    return { rows: removed, done: true };
  }

  private async hardDelete(noteIds: string[]): Promise<void> {
    // Порядок несущий: сначала файлы (у них своё хранилище и свой reaper), потом ОДНОЙ
    // транзакцией гранты и строки — иначе обрыв посередине оставлял бы живую заметку
    // без грантов, то есть невидимой всем, кому её открывали.
    await this.files.unlinkAllForRefs(NOTE_REF_TYPE, noteIds).catch(() => undefined);
    await this.db.$transaction(async (tx) => {
      for (const id of noteIds) await this.acl.revokeAll(NOTE_REF_TYPE, id, tx);
      await tx.note.deleteMany({ where: { id: { in: noteIds } } });
    });
    for (const id of noteIds) await this.search.remove(id);
  }

  // ============================================================
  // Привязки к сущностям
  // ============================================================

  async addRelated(userId: string, noteId: string, targetType: NoteRelatedTargetType, targetId: string): Promise<NoteDetailDto> {
    const { note, scope, access } = await this.requireNote(userId, noteId, 'editor');
    const described = await this.links.requireTarget(userId, scope, targetType, targetId);
    await this.db.$transaction(async (tx) => {
      const added = await this.links.addRelated(tx, noteId, targetType, targetId, userId);
      if (added) await this.log(tx, scope, noteId, 'note.related', { ...this.logTitle(note), to: described.title });
    });
    return this.detail(scope, note, access);
  }

  async removeRelated(userId: string, noteId: string, targetType: string, targetId: string): Promise<NoteDetailDto> {
    const { note, scope, access } = await this.requireNote(userId, noteId, 'editor');
    await this.db.$transaction(async (tx) => {
      const removed = await this.links.removeRelated(tx, noteId, targetType, targetId);
      if (removed) await this.log(tx, scope, noteId, 'note.unrelated', { ...this.logTitle(note), from: targetType });
    });
    return this.detail(scope, note, access);
  }

  // ============================================================
  // Служебное
  // ============================================================

  /**
   * Хроника заметки. Ошибку НЕ глушим: `.catch(() => undefined)` внутри открытой
   * транзакции всё равно не спасал — упавший запрос обрывает её целиком, просто
   * следующий шаг падал уже без объяснения причины.
   */
  async log(
    tx: Tx | null,
    scope: NoteScope,
    noteId: string,
    typeKey: string,
    payload: Record<string, unknown>,
    changes?: Array<{ field: string; label: string; from: string | null; to: string | null }>,
  ): Promise<void> {
    const actor = await (tx ?? this.db).user.findUnique({ where: { id: scope.userId }, select: { firstName: true, lastName: true } });
    await this.chatter.log(tx, {
      refType: NOTE_REF_TYPE,
      refId: noteId,
      workspaceId: scope.space.ownerType === 'workspace' ? scope.space.ownerId : null,
      actorId: scope.userId,
      // Имени нет (аккаунт исчез) → null: слово-заглушку подставит рендер в языке зрителя.
      actorName: actor ? fullName(actor) : null,
      typeKey,
      payload,
      changes: changes ?? null,
    });
  }

  /** Лёгкие строки заметок по id (доска, карточки) */
  async loadRows(ids: string[]): Promise<NoteFullRow[]> {
    if (!ids.length) return [];
    return this.db.note.findMany({ where: { id: { in: ids } }, select: NOTE_FULL_SELECT });
  }
}

// ============================================================
// Keyset-пагинация списка
// ============================================================

interface ListCursor {
  trashed: boolean;
  /** Закрепление курсорной строки (null — не закреплена); только для обычного списка */
  pinnedAt?: string | null;
  /** updated_at (обычный список) или deleted_at (корзина) */
  at: string;
  id: string;
}

/** Курсор корзины для раннера сроков: (deletedAt, id) */
const TRASH_CURSOR = { d: 'date', i: 'uuid' } as const;

/** Курсор списка заметок — общий кодек платформы (`@superapp/shared` utils/cursor); мусорный = начало списка. */
const NOTE_CURSOR = { t: 'boolean', p: 'date?', a: 'date', i: 'uuid' } as const;

function encodeCursor(c: ListCursor): string {
  return encodeKeyset({ t: c.trashed, p: c.trashed ? null : (c.pinnedAt ?? null), a: c.at, i: c.id });
}

function decodeCursor(raw: string): ListCursor | null {
  const c = decodeKeyset(raw, NOTE_CURSOR);
  if (!c) return null;
  const at = c.a.toISOString();
  return c.t ? { trashed: true, at, id: c.i } : { trashed: false, pinnedAt: c.p ? c.p.toISOString() : null, at, id: c.i };
}

/**
 * «Строго после курсора» в том же порядке, что и orderBy:
 * корзина — (deleted_at desc, id desc); обычный список — (pinned_at desc NULLS LAST,
 * updated_at desc, id desc): незакреплённые идут после ВСЕХ закреплённых.
 */
function keysetWhere(c: ListCursor | null, trashed: boolean): Prisma.NoteWhereInput {
  if (!c || c.trashed !== trashed) return {};
  const at = new Date(c.at);
  if (Number.isNaN(at.getTime())) return {};
  if (trashed) {
    return { OR: [{ deletedAt: { lt: at } }, { deletedAt: at, id: { lt: c.id } }] };
  }
  const tail: Prisma.NoteWhereInput[] = [
    { pinnedAt: c.pinnedAt ? new Date(c.pinnedAt) : null, updatedAt: { lt: at } },
    { pinnedAt: c.pinnedAt ? new Date(c.pinnedAt) : null, updatedAt: at, id: { lt: c.id } },
  ];
  if (!c.pinnedAt) return { OR: tail };
  return { OR: [{ pinnedAt: { lt: new Date(c.pinnedAt) } }, { pinnedAt: null }, ...tail] };
}

export type { NoteFullRow };
export { NOTE_FULL_SELECT };
