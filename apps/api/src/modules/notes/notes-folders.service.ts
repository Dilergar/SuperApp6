import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NOTE_FOLDER_REF_TYPE,
  NOTE_LIMITS,
  NOTE_REF_TYPE,
  type CreateNoteFolderInput,
  type NoteAccess,
  type NoteFolderDto,
  type UpdateNoteFolderInput,
} from '@superapp/shared';
import { SOURCE_LOCALE } from '@superapp/shared';
import { ChatterService } from '../../core/chatter/chatter.service';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { fullName } from '../../shared/utils/user-name';
import { NotesAccessService, type NoteScope } from './notes-access.service';

type Tx = Prisma.TransactionClient;

export type NoteFolderRow = Prisma.NoteFolderGetPayload<{ select: typeof FOLDER_SELECT }>;

export const FOLDER_SELECT = {
  id: true,
  spaceId: true,
  parentId: true,
  name: true,
  nameKey: true,
  color: true,
  ancestorIds: true,
  depth: true,
  sortRank: true,
  createdById: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.NoteFolderSelect;

/** NFC + нижний регистр: «Клиенты» и «клиенты» — одна папка; составное «й» не даёт дубля */
export function folderNameKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * Дерево папок заметок. Материализованные предки (`ancestorIds` от корня, без себя) и
 * `Note.folderPath` = [папка, …предки] — на них держится наследование грантов и
 * перенос поддерева одним UPDATE (паттерн Диска).
 */
@Injectable()
export class NotesFoldersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly chatter: ChatterService,
    private readonly i18n: I18nService,
  ) {}

  // ------------------------------------------------------------
  // Чтение
  // ------------------------------------------------------------

  /** Живые папки, видимые зрителю (владелец пространства — все; иначе свои + выданные с предками) */
  async listVisible(scope: NoteScope): Promise<NoteFolderRow[]> {
    return this.db.noteFolder.findMany({
      where: { ...this.acl.visibleFoldersWhere(scope), deletedAt: null },
      select: FOLDER_SELECT,
      orderBy: [{ depth: 'asc' }, { sortRank: 'asc' }, { name: 'asc' }],
    });
  }

  /** Папки ДРУГИХ пространств, открытые зрителю (раздел «Открытые мне») */
  async listForeign(scope: NoteScope): Promise<NoteFolderRow[]> {
    const where = this.acl.foreignFoldersWhere(scope);
    if (!where) return [];
    return this.db.noteFolder.findMany({
      where,
      select: FOLDER_SELECT,
      orderBy: [{ depth: 'asc' }, { sortRank: 'asc' }, { name: 'asc' }],
      take: NOTE_LIMITS.foreignFoldersLimit,
    });
  }

  async requireFolder(scope: NoteScope, folderId: string, need: 'viewer' | 'editor' | 'manager'): Promise<{ folder: NoteFolderRow; access: NoteAccess }> {
    const folder = await this.db.noteFolder.findUnique({ where: { id: folderId }, select: FOLDER_SELECT });
    if (!folder || folder.spaceId !== scope.space.id || folder.deletedAt) throw notFound('notes.folderNotFound');
    const access = this.acl.assertAccess(this.acl.folderAccess(scope, folder), need, 'folder');
    return { folder, access };
  }

  toDto(folder: NoteFolderRow, access: NoteAccess, notesCount: number): NoteFolderDto {
    return {
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      color: folder.color,
      depth: folder.depth,
      ancestorIds: folder.ancestorIds,
      notesCount,
      access,
      createdById: folder.createdById,
      updatedAt: folder.updatedAt.toISOString(),
    };
  }

  /** Пространство папки (для скоупа контроллера); нет папки — 404 */
  async spaceIdOf(folderId: string): Promise<string> {
    const row = await this.db.noteFolder.findUnique({ where: { id: folderId }, select: { spaceId: true } });
    if (!row) throw notFound('notes.folderNotFound');
    return row.spaceId;
  }

  /**
   * Крошки папки: от корня к самой папке. Показываем только те папки пути, которые
   * зритель ВИДИТ — иначе заметка, открытая ему напрямую, выдавала бы названия чужих
   * папок владельца («Личное › Развод › …»).
   */
  async crumbs(scope: NoteScope, folderId: string | null): Promise<Array<{ id: string; name: string }>> {
    if (!folderId) return [];
    const folder = await this.db.noteFolder.findUnique({
      where: { id: folderId },
      select: { id: true, name: true, ancestorIds: true, createdById: true, spaceId: true },
    });
    if (!folder) return [];
    const ancestors = folder.ancestorIds.length
      ? await this.db.noteFolder.findMany({ where: { id: { in: folder.ancestorIds } }, select: FOLDER_SELECT })
      : [];
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    const visible = (f: { id: string; createdById: string; ancestorIds: string[]; spaceId: string }) =>
      f.spaceId === scope.space.id ? !!this.acl.folderAccess(scope, f) : !!this.acl.foreignFolderAccess(scope, f);
    const chain: Array<{ id: string; name: string }> = [];
    for (const id of folder.ancestorIds) {
      const a = byId.get(id);
      if (a && visible(a)) chain.push({ id: a.id, name: a.name });
    }
    if (visible(folder)) chain.push({ id: folder.id, name: folder.name });
    return chain;
  }

  // ------------------------------------------------------------
  // Запись
  // ------------------------------------------------------------

  async create(scope: NoteScope, input: CreateNoteFolderInput): Promise<NoteFolderRow> {
    let ancestorIds: string[] = [];
    let depth = 0;
    if (input.parentId) {
      const { folder: parent } = await this.requireFolder(scope, input.parentId, 'editor');
      ancestorIds = [...parent.ancestorIds, parent.id];
      depth = parent.depth + 1;
      if (depth > NOTE_LIMITS.maxFolderDepth) throw badRequest('notes.folderTooDeep');
    } else if (!scope.member) {
      throw notFound('notes.spaceNotFound');
    }
    const created = await this.db
      .$transaction(async (tx) => {
        const row = await tx.noteFolder.create({
          data: {
            spaceId: scope.space.id,
            parentId: input.parentId ?? null,
            name: input.name,
            nameKey: folderNameKey(input.name),
            color: input.color ?? null,
            ancestorIds,
            depth,
            createdById: scope.userId,
          },
          select: FOLDER_SELECT,
        });
        await this.log(tx, scope, row.id, 'note.folder.created', { targetName: row.name });
        return row;
      })
      .catch((err: { code?: string }) => {
        if (err?.code === 'P2002') throw badRequest('notes.folderNameTaken');
        throw err;
      });
    return created;
  }

  async update(scope: NoteScope, folderId: string, input: UpdateNoteFolderInput): Promise<NoteFolderRow> {
    const need = input.parentId !== undefined ? 'manager' : 'editor';
    const { folder } = await this.requireFolder(scope, folderId, need);

    if (input.parentId !== undefined && input.parentId !== folder.parentId) {
      await this.move(scope, folder, input.parentId);
    }
    const data: Prisma.NoteFolderUpdateInput = {};
    if (input.name !== undefined && input.name !== folder.name) {
      data.name = input.name;
      data.nameKey = folderNameKey(input.name);
    }
    if (input.color !== undefined) data.color = input.color;
    let updated = folder;
    if (Object.keys(data).length) {
      updated = await this.db
        .$transaction(async (tx) => {
          const row = await tx.noteFolder.update({ where: { id: folderId }, data, select: FOLDER_SELECT });
          if (data.name) {
            await this.log(tx, scope, folderId, 'note.folder.renamed', { targetName: row.name }, [
              {
                field: 'name',
                label: this.i18n.translateFor(SOURCE_LOCALE, 'chatter.fields.note_folder.name'),
                from: folder.name,
                to: row.name,
              },
            ]);
          }
          return row;
        })
        .catch((err: { code?: string }) => {
          if (err?.code === 'P2002') throw badRequest('notes.folderNameTaken');
          throw err;
        });
    } else if (input.parentId !== undefined) {
      updated = (await this.db.noteFolder.findUnique({ where: { id: folderId }, select: FOLDER_SELECT })) ?? folder;
    }
    return updated;
  }

  /**
   * Перенос поддерева: у потомков заменяется префикс предков, у заметок внутри —
   * пересчитывается folderPath. Всё в одной транзакции двумя UPDATE по GIN.
   */
  private async move(scope: NoteScope, folder: NoteFolderRow, newParentId: string | null): Promise<void> {
    let newAncestors: string[] = [];
    let newDepth = 0;
    if (newParentId) {
      if (newParentId === folder.id) throw badRequest('notes.folderIntoItself');
      const { folder: parent } = await this.requireFolder(scope, newParentId, 'editor');
      if (parent.ancestorIds.includes(folder.id)) throw badRequest('notes.folderIntoOwnChild');
      newAncestors = [...parent.ancestorIds, parent.id];
      newDepth = parent.depth + 1;
    } else if (!scope.member) {
      throw notFound('notes.spaceNotFound');
    }
    const deepest = await this.db.noteFolder.aggregate({
      where: { ancestorIds: { has: folder.id }, deletedAt: null },
      _max: { depth: true },
    });
    const subtreeDepth = (deepest._max.depth ?? folder.depth) - folder.depth;
    if (newDepth + subtreeDepth > NOTE_LIMITS.maxFolderDepth) {
      throw badRequest('notes.folderTooDeep');
    }
    const oldPrefixLen = folder.ancestorIds.length; // сколько элементов заменить у потомков
    // Куда переехала папка: имя родителя — ДАННЫЕ, «Корень» — СЛОВО продукта.
    // Слово едет в вечную запись ключом (`toKey` → `to` при чтении, docs/i18n.md):
    // записанное фразой, оно застыло бы в языке того, кто перетащил папку.
    const target: Record<string, string> = newParentId
      ? { to: (await this.db.noteFolder.findUnique({ where: { id: newParentId }, select: { name: true } }))?.name ?? '' }
      : { toKey: 'notes.rootName' };

    await this.db.$transaction(async (tx) => {
      await tx.noteFolder.update({
        where: { id: folder.id },
        data: { parentId: newParentId, ancestorIds: newAncestors, depth: newDepth },
      });
      // Потомки: новый префикс + хвост старого пути после переносимой папки
      await tx.$executeRaw`
        UPDATE "note_folders"
           SET "ancestor_ids" = ${newAncestors}::uuid[] || "ancestor_ids"[${oldPrefixLen + 1}:],
               "depth" = "depth" + ${newDepth - folder.depth}
         WHERE "ancestor_ids" @> ARRAY[${folder.id}]::uuid[]`;
      // Заметки в поддереве: путь = [папка] || предки папки
      await tx.$executeRaw`
        UPDATE "notes" n
           SET "folder_path" = ARRAY[f."id"]::uuid[] || f."ancestor_ids"
          FROM "note_folders" f
         WHERE n."folder_id" = f."id"
           AND (f."id" = ${folder.id}::uuid OR f."ancestor_ids" @> ARRAY[${folder.id}]::uuid[])`;
      await this.log(tx, scope, folder.id, 'note.folder.moved', { targetName: folder.name, ...target });
    });
  }

  /** В корзину: папка, подпапки и заметки внутри — одной отметкой времени (по ней и восстанавливаем) */
  async trash(scope: NoteScope, folderId: string): Promise<{ noteIds: string[] }> {
    const { folder } = await this.requireFolder(scope, folderId, 'manager');
    const now = new Date();
    const noteIds = await this.db.$transaction(async (tx) => {
      const subtree = await tx.noteFolder.findMany({
        where: { OR: [{ id: folder.id }, { ancestorIds: { has: folder.id } }], deletedAt: null },
        select: { id: true },
      });
      const ids = subtree.map((f) => f.id);
      await tx.noteFolder.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now } });
      const notes = await tx.note.findMany({ where: { folderId: { in: ids }, deletedAt: null }, select: { id: true } });
      await tx.note.updateMany({ where: { id: { in: notes.map((n) => n.id) } }, data: { deletedAt: now } });
      await this.log(tx, scope, folder.id, 'note.folder.trashed', { targetName: folder.name });
      return notes.map((n) => n.id);
    });
    return { noteIds };
  }

  /** Восстановить папку с тем, что удалялось вместе с ней; родитель в корзине → в корень */
  async restore(scope: NoteScope, folderId: string): Promise<{ noteIds: string[] }> {
    const folder = await this.db.noteFolder.findUnique({ where: { id: folderId }, select: FOLDER_SELECT });
    if (!folder || folder.spaceId !== scope.space.id || !folder.deletedAt) throw notFound('notes.folderNotFound');
    this.acl.assertAccess(this.acl.folderAccess(scope, folder), 'manager', 'folder');
    const stamp = folder.deletedAt;
    const noteIds = await this.db.$transaction(async (tx) => {
      const subtree = await tx.noteFolder.findMany({
        where: { OR: [{ id: folder.id }, { ancestorIds: { has: folder.id } }], deletedAt: stamp },
        select: { id: true },
      });
      const ids = subtree.map((f) => f.id);
      await tx.noteFolder.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
      const notes = await tx.note.findMany({ where: { folderId: { in: ids }, deletedAt: stamp }, select: { id: true } });
      await tx.note.updateMany({ where: { id: { in: notes.map((n) => n.id) } }, data: { deletedAt: null } });
      // Родитель всё ещё в корзине (или удалён) — поднимаем поддерево в корень
      const parentAlive = folder.parentId
        ? await tx.noteFolder.findFirst({ where: { id: folder.parentId, deletedAt: null }, select: { id: true } })
        : null;
      if (folder.parentId && !parentAlive) await this.reparentToRoot(tx, folder);
      await this.log(tx, scope, folder.id, 'note.folder.restored', { targetName: folder.name });
      return notes.map((n) => n.id);
    });
    return { noteIds };
  }

  private async reparentToRoot(tx: Tx, folder: NoteFolderRow): Promise<void> {
    const oldPrefixLen = folder.ancestorIds.length;
    await tx.noteFolder.update({ where: { id: folder.id }, data: { parentId: null, ancestorIds: [], depth: 0 } });
    await tx.$executeRaw`
      UPDATE "note_folders"
         SET "ancestor_ids" = "ancestor_ids"[${oldPrefixLen + 1}:], "depth" = "depth" - ${folder.depth}
       WHERE "ancestor_ids" @> ARRAY[${folder.id}]::uuid[]`;
    await tx.$executeRaw`
      UPDATE "notes" n SET "folder_path" = ARRAY[f."id"]::uuid[] || f."ancestor_ids"
        FROM "note_folders" f
       WHERE n."folder_id" = f."id" AND (f."id" = ${folder.id}::uuid OR f."ancestor_ids" @> ARRAY[${folder.id}]::uuid[])`;
  }

  /** Папки, пролежавшие в корзине дольше ретеншна (заметки внутри чистит purge заметок) */
  /**
   * Пачка корзины папок (шаг `notes.trash` / политика `NoteFolder`): удалённые раньше
   * `before`, keyset по id (удерживаемые заморозкой остаются и курсором обходятся).
   */
  async purgeTrashFoldersBatch(opts: {
    before: Date;
    limit: number;
    after: string | null;
    releasable: (tx: Prisma.TransactionClient, ids: readonly string[]) => Promise<string[]>;
  }): Promise<{ rows: number; more: boolean; last: string | null }> {
    const take = Math.min(opts.limit, NOTE_LIMITS.purgeBatch);
    const rows = await this.db.noteFolder.findMany({
      where: { deletedAt: { lt: opts.before }, ...(opts.after ? { id: { gt: opts.after } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    if (!rows.length) return { rows: 0, more: false, last: null };
    const last = rows[rows.length - 1]!.id;
    const count = await this.db.$transaction(async (tx) => {
      const ids = await opts.releasable(tx, rows.map((r) => r.id));
      if (!ids.length) return 0;
      for (const id of ids) await this.acl.revokeAll(NOTE_FOLDER_REF_TYPE, id, tx);
      // FK ставит folder_id = NULL, но материализованный путь остаётся ссылаться на
      // мёртвые папки — чистим руками, иначе заметка «в корне» тащит призрачный путь.
      await tx.$executeRaw`
        UPDATE "notes"
           SET "folder_path" = ARRAY(SELECT unnest("folder_path") EXCEPT SELECT unnest(${ids}::uuid[]))
         WHERE "folder_path" && ${ids}::uuid[]`;
      const res = await tx.noteFolder.deleteMany({ where: { id: { in: ids } } });
      return res.count;
    });
    return { rows: count, more: rows.length === take, last };
  }

  /** Счётчики живых заметок по папкам — одним groupBy под предикатом видимости */
  async countNotesByFolder(scope: NoteScope): Promise<Map<string | null, number>> {
    const rows = await this.db.note.groupBy({
      by: ['folderId'],
      where: { ...this.acl.visibleNotesWhere(scope), deletedAt: null },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.folderId, r._count._all]));
  }

  /** Счётчики для папок чужих пространств (их заметки под предикат «поделились со мной») */
  async countNotesInForeignFolders(scope: NoteScope, folderIds: string[]): Promise<Map<string | null, number>> {
    if (!folderIds.length) return new Map();
    const rows = await this.db.note.groupBy({
      by: ['folderId'],
      where: { AND: [this.acl.sharedNotesWhere(scope), { deletedAt: null, folderId: { in: folderIds } }] },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.folderId, r._count._all]));
  }

  /**
   * Хроника папки — СИНХРОННО в транзакции мутации (правило платформы). Ошибку не
   * глушим: проглоченный сбой внутри открытой транзакции всё равно обрывал бы её
   * следующим запросом, только уже без объяснения.
   */
  async log(
    tx: Tx,
    scope: NoteScope,
    folderId: string,
    typeKey: string,
    payload: Record<string, unknown>,
    changes?: Array<{ field: string; label: string; from: string | null; to: string | null }>,
  ): Promise<void> {
    const actor = await tx.user.findUnique({ where: { id: scope.userId }, select: { firstName: true, lastName: true } });
    await this.chatter.log(tx, {
      refType: NOTE_FOLDER_REF_TYPE,
      refId: folderId,
      workspaceId: scope.space.ownerType === 'workspace' ? scope.space.ownerId : null,
      actorId: scope.userId,
      // Имени нет (аккаунт исчез) → null: слово-заглушку подставит рендер в языке
      // зрителя. Записанное здесь, оно застыло бы английским навсегда.
      actorName: actor ? fullName(actor) : null,
      typeKey,
      payload,
      changes: changes ?? null,
    });
  }
}

export { NOTE_REF_TYPE };
