import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NOTE_FOLDER_REF_TYPE,
  NOTE_REF_TYPE,
  NOTE_ROLE_RANK,
  NOTE_ROLES,
  WORKSPACE_ROLE_RANK,
  type NoteAccess,
  type NoteRole,
  type NoteSpaceRef,
  type WorkspaceRole,
} from '@superapp/shared';
import { AccessService } from '../../core/access/access.service';
import { principalSubjectRelation } from '../../core/access/access-schema';
import { RolesService } from '../../core/roles/roles.service';
import { DatabaseService } from '../../shared/database/database.service';
import { forbidden, notFound } from '../../shared/errors/api-error';

type Tx = Prisma.TransactionClient;

export interface NoteSpaceRow {
  id: string;
  ownerType: string;
  ownerId: string;
}

/** Набор id по уровню доступа. Наборы НАКОПИТЕЛЬНЫЕ: manager ⊂ editor ⊂ viewer. */
export interface NoteLevelGrants {
  viewer: string[];
  editor: string[];
  manager: string[];
}

export interface NoteGrants {
  folders: NoteLevelGrants;
  notes: NoteLevelGrants;
}

/** Всё, что нужно любому читающему пути: пространство, право на него целиком и гранты */
export interface NoteScope {
  userId: string;
  space: NoteSpaceRow;
  /** 'owner' — хозяин личного пространства или owner/admin организации (надзор) */
  spaceAccess: NoteAccess | null;
  /** Член команды организации (trainee+) / хозяин личного пространства */
  member: boolean;
  grants: NoteGrants;
}

const EMPTY_LEVELS: NoteLevelGrants = { viewer: [], editor: [], manager: [] };

/**
 * Права Заметок — модель Диска.
 *
 * core/access ХРАНИТ гранты (по строке на шеринг: на заметке или на папке), а
 * наследование по дереву папок считает сервис ОДНИМ условием: у заметки
 * материализован `folderPath` = [своя папка, …её предки], и «выдано на папку выше»
 * превращается в `folder_path && granted`. Владелец пространства (хозяин личных
 * заметок; владелец/админ организации) видит всё; автор заметки — её manager всегда.
 *
 * ⚠️ `check()`/`can()` движка для типов заметок НЕ используются (пустой EPOCH_FANOUT —
 * кэш никто не инвалидирует). Все решения — здесь, по живым tuples через grantSetFor.
 */
@Injectable()
export class NotesAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
  ) {}

  // ------------------------------------------------------------
  // Пространство
  // ------------------------------------------------------------

  /** Найти/создать пространство по адресу запроса и собрать скоуп зрителя (fail-closed по членству) */
  async scopeFor(userId: string, ref: NoteSpaceRef): Promise<NoteScope> {
    // Членство проверяем ДО создания пространства: иначе любой запрос с чужим
    // workspaceId заводил строку note_spaces и только потом получал отказ.
    if (ref.workspaceId) {
      const rank = await this.workspaceRank(userId, ref.workspaceId);
      if (rank < WORKSPACE_ROLE_RANK.trainee) throw forbidden('notes.notInWorkspace');
    }
    const space = await this.ensureSpace(ref.workspaceId ? 'workspace' : 'user', ref.workspaceId ?? userId);
    return this.scopeForSpace(userId, space);
  }

  async scopeForSpace(userId: string, space: NoteSpaceRow): Promise<NoteScope> {
    let spaceAccess: NoteAccess | null = null;
    let member = false;
    if (space.ownerType === 'user') {
      member = space.ownerId === userId;
      spaceAccess = member ? 'owner' : null;
    } else {
      const rank = await this.workspaceRank(userId, space.ownerId);
      // Подрядчик изолирован: рабочие заметки ему не показываются вовсе.
      member = rank >= WORKSPACE_ROLE_RANK.trainee;
      if (!member) throw forbidden('notes.notInWorkspace');
      spaceAccess = rank >= WORKSPACE_ROLE_RANK.admin ? 'owner' : null;
    }
    const grants = await this.grantsFor(userId);
    return { userId, space, spaceAccess, member, grants };
  }

  /** Скоуп по id пространства (чужие заметки, расшаренные мне, живут в чужом пространстве) */
  async scopeForSpaceId(userId: string, spaceId: string): Promise<NoteScope> {
    const space = await this.db.noteSpace.findUnique({ where: { id: spaceId } });
    if (!space) throw notFound('notes.noteNotFound');
    // Личное пространство другого человека: членства нет, доступ только по грантам.
    if (space.ownerType === 'user' && space.ownerId !== userId) {
      return { userId, space, spaceAccess: null, member: false, grants: await this.grantsFor(userId) };
    }
    if (space.ownerType === 'workspace') {
      const rank = await this.workspaceRank(userId, space.ownerId);
      if (rank < WORKSPACE_ROLE_RANK.trainee) {
        // Не член организации: заметка могла быть расшарена персонально — гранты решают.
        return { userId, space, spaceAccess: null, member: false, grants: await this.grantsFor(userId) };
      }
    }
    return this.scopeForSpace(userId, space);
  }

  async ensureSpace(ownerType: 'user' | 'workspace', ownerId: string, tx?: Tx): Promise<NoteSpaceRow> {
    const db = tx ?? this.db;
    const found = await db.noteSpace.findUnique({ where: { ownerType_ownerId: { ownerType, ownerId } } });
    if (found) return found;
    if (ownerType === 'workspace') {
      const ws = await db.workspace.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!ws) throw notFound('notes.workspaceNotFound');
    }
    // Гонка двух первых запросов: unique (owner_type, owner_id) — второй перечитывает.
    return db.noteSpace
      .create({ data: { ownerType, ownerId } })
      .catch(async (err: { code?: string }) => {
        if (err?.code !== 'P2002') throw err;
        const again = await db.noteSpace.findUnique({ where: { ownerType_ownerId: { ownerType, ownerId } } });
        if (!again) throw err;
        return again;
      });
  }

  /** Наивысшая роль зрителя в организации (0 — не в команде) */
  async workspaceRank(userId: string, workspaceId: string): Promise<number> {
    const rows = await this.roles.getRolesInContext(userId, 'workspace', workspaceId);
    let best = 0;
    for (const r of rows) best = Math.max(best, WORKSPACE_ROLE_RANK[r.role as WorkspaceRole] ?? 0);
    return best;
  }

  // ------------------------------------------------------------
  // Гранты
  // ------------------------------------------------------------

  /** Все папки и заметки, на которые зрителю что-то выдано (два похода в движок) */
  async grantsFor(userId: string): Promise<NoteGrants> {
    const [f, n] = await Promise.all([
      this.access.grantSetFor(userId, NOTE_FOLDER_REF_TYPE),
      this.access.grantSetFor(userId, NOTE_REF_TYPE),
    ]);
    return { folders: levels(f.granted), notes: levels(n.granted) };
  }

  // ------------------------------------------------------------
  // Решения по объектам
  // ------------------------------------------------------------

  /**
   * Права зрителя на заметке: максимум из «владею пространством», «я автор» и грантов
   * на самой заметке и на любой папке её пути. Права СКЛАДЫВАЮТСЯ (модель Google Drive).
   */
  noteAccess(scope: NoteScope, note: { id: string; createdById: string; folderPath: string[] }): NoteAccess | null {
    if (scope.spaceAccess === 'owner') return 'owner';
    if (note.createdById === scope.userId && authorCounts(scope)) return 'manager';
    for (const role of ['manager', 'editor', 'viewer'] as const) {
      if (scope.grants.notes[role].includes(note.id)) return role;
      if (note.folderPath.length && scope.grants.folders[role].some((id) => note.folderPath.includes(id))) return role;
    }
    return null;
  }

  folderAccess(scope: NoteScope, folder: { id: string; createdById: string; ancestorIds: string[] }): NoteAccess | null {
    if (scope.spaceAccess === 'owner') return 'owner';
    if (folder.createdById === scope.userId && authorCounts(scope)) return 'manager';
    const chain = [folder.id, ...folder.ancestorIds];
    for (const role of ['manager', 'editor', 'viewer'] as const) {
      if (scope.grants.folders[role].some((id) => chain.includes(id))) return role;
    }
    return null;
  }

  /**
   * Права на папку ЧУЖОГО пространства — только по грантам: владение своим
   * пространством и авторство здесь ничего не значат (folderAccess дал бы 'owner'
   * любому хозяину его собственного пространства).
   */
  foreignFolderAccess(scope: NoteScope, folder: { id: string; ancestorIds: string[] }): NoteAccess | null {
    const chain = [folder.id, ...folder.ancestorIds];
    for (const role of ['manager', 'editor', 'viewer'] as const) {
      if (scope.grants.folders[role].some((id) => chain.includes(id))) return role;
    }
    return null;
  }

  /**
   * Бросить, если прав не хватает: чужое = 404 (не выдаём существование), мало = 403.
   * `subject` называет ПРЕДМЕТ отказа кодом — слова обоим даёт каталог.
   */
  assertAccess(access: NoteAccess | null, need: NoteRole, subject: 'note' | 'folder' = 'note'): NoteAccess {
    const folder = subject === 'folder';
    if (!access) throw notFound(folder ? 'notes.folderNotFound' : 'notes.noteNotFound');
    if (rank(access) < NOTE_ROLE_RANK[need]) {
      throw forbidden(
        need === 'manager'
          ? 'notes.ownerManagesAccess'
          : folder
            ? 'notes.readOnlyFolder'
            : 'notes.readOnlyNote',
      );
    }
    return access;
  }

  /**
   * Prisma-условие видимости заметок в пространстве (ОДНО условие, без check() в цикле):
   * владелец пространства → всё; иначе — свои, выданные напрямую, выданные через папку.
   */
  visibleNotesWhere(scope: NoteScope, need: NoteRole = 'viewer'): Prisma.NoteWhereInput {
    const base: Prisma.NoteWhereInput = { spaceId: scope.space.id };
    if (scope.spaceAccess === 'owner') return base;
    const or: Prisma.NoteWhereInput[] = [];
    // Условие обязано совпадать с noteAccess(), иначе список и прямая ссылка разойдутся
    if (authorCounts(scope)) or.push({ createdById: scope.userId });
    const notes = scope.grants.notes[need];
    const folders = scope.grants.folders[need];
    if (notes.length) or.push({ id: { in: notes } });
    if (folders.length) or.push({ folderPath: { hasSome: folders } });
    if (!or.length) return { ...base, id: { in: [] } };
    return { ...base, OR: or };
  }

  /**
   * «Поделились со мной» — заметки, доступные зрителю ВНЕ его собственного хозяйства:
   * чужие заметки активного пространства (для владельца/админа таких нет — он видит всё
   * по надзору, и раздел не про это) плюс всё, что выдано ему в ДРУГИХ пространствах,
   * включая его же заметки, созданные в открытой ему чужой папке. Без этого условия
   * личный шеринг не имел бы витрины: заметка соседа живёт в его пространстве, а списки
   * скоуплены одним.
   */
  sharedNotesWhere(scope: NoteScope): Prisma.NoteWhereInput {
    const or: Prisma.NoteWhereInput[] = [];
    if (scope.spaceAccess !== 'owner') {
      or.push({ AND: [this.visibleNotesWhere(scope), { createdById: { not: scope.userId } }] });
    }
    const elsewhere: Prisma.NoteWhereInput[] = [];
    if (scope.grants.notes.viewer.length) elsewhere.push({ id: { in: scope.grants.notes.viewer } });
    if (scope.grants.folders.viewer.length) elsewhere.push({ folderPath: { hasSome: scope.grants.folders.viewer } });
    // Своя заметка в чужом ЛИЧНОМ пространстве: автор остаётся её управляющим
    elsewhere.push({ createdById: scope.userId, space: { ownerType: 'user', ownerId: { not: scope.userId } } });
    or.push({ AND: [{ spaceId: { not: scope.space.id } }, { OR: elsewhere }] });
    return { OR: or };
  }

  /** Папки других пространств, выданные зрителю (раздел «Открытые мне» в дереве) */
  foreignFoldersWhere(scope: NoteScope): Prisma.NoteFolderWhereInput | null {
    const granted = scope.grants.folders.viewer;
    if (!granted.length) return null;
    return {
      spaceId: { not: scope.space.id },
      deletedAt: null,
      OR: [{ id: { in: granted } }, { ancestorIds: { hasSome: granted } }],
    };
  }

  visibleFoldersWhere(scope: NoteScope): Prisma.NoteFolderWhereInput {
    const base: Prisma.NoteFolderWhereInput = { spaceId: scope.space.id };
    if (scope.spaceAccess === 'owner') return base;
    const or: Prisma.NoteFolderWhereInput[] = [];
    if (authorCounts(scope)) or.push({ createdById: scope.userId });
    const folders = scope.grants.folders.viewer;
    if (folders.length) or.push({ id: { in: folders } }, { ancestorIds: { hasSome: folders } });
    if (!or.length) return { ...base, id: { in: [] } };
    return { ...base, OR: or };
  }

  /**
   * Сырое SQL-условие видимости заметки (алиас — литерал вызывающего кода). Для
   * поиска: пространства зрителя (владелец/админ) схлопываются в btree по space_id,
   * остальное — GIN по folder_path.
   */
  visibilitySql(
    alias: string,
    ownerSpaceIds: string[],
    memberSpaceIds: string[],
    userId: string,
    grants: NoteGrants,
  ): Prisma.Sql {
    const col = Prisma.raw(`"${alias}"`);
    const parts: Prisma.Sql[] = [];
    if (ownerSpaceIds.length) parts.push(Prisma.sql`${col}."space_id" = ANY(${ownerSpaceIds}::text[])`);
    if (memberSpaceIds.length) {
      parts.push(Prisma.sql`(${col}."space_id" = ANY(${memberSpaceIds}::text[]) AND ${col}."created_by_id" = ${userId})`);
    }
    if (grants.notes.viewer.length) parts.push(Prisma.sql`${col}."id" = ANY(${grants.notes.viewer}::text[])`);
    if (grants.folders.viewer.length) parts.push(Prisma.sql`${col}."folder_path" && ${grants.folders.viewer}::text[]`);
    if (!parts.length) return Prisma.sql`FALSE`;
    return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
  }

  // ------------------------------------------------------------
  // Гранты: запись
  // ------------------------------------------------------------

  async grant(
    refType: typeof NOTE_REF_TYPE | typeof NOTE_FOLDER_REF_TYPE,
    refId: string,
    role: NoteRole,
    principal: { type: string; id: string },
    tx?: Tx,
  ): Promise<void> {
    // Одна роль на принципала: смена роли не должна оставлять старую строку.
    for (const other of NOTE_ROLES) {
      if (other !== role) await this.revoke(refType, refId, other, principal, tx);
    }
    await this.access.grant(
      {
        resourceType: refType,
        resourceId: refId,
        relation: role,
        subjectType: principal.type,
        subjectId: principal.id,
        subjectRelation: principalSubjectRelation(principal.type),
      },
      tx,
    );
  }

  async revoke(
    refType: typeof NOTE_REF_TYPE | typeof NOTE_FOLDER_REF_TYPE,
    refId: string,
    role: NoteRole,
    principal: { type: string; id: string },
    tx?: Tx,
  ): Promise<void> {
    await this.access.revoke(
      {
        resourceType: refType,
        resourceId: refId,
        relation: role,
        subjectType: principal.type,
        subjectId: principal.id,
        subjectRelation: principalSubjectRelation(principal.type),
      },
      tx,
    );
  }

  async revokeAll(refType: string, refId: string, tx?: Tx): Promise<void> {
    await this.access.revokeResource(refType, refId, tx);
  }

  /** Все гранты на наборе ресурсов (панель «Доступ») */
  async listGrants(
    refType: string,
    refIds: string[],
  ): Promise<Array<{ resourceId: string; relation: string; subjectType: string; subjectId: string }>> {
    if (!refIds.length) return [];
    return this.db.relationTuple.findMany({
      where: { resourceType: refType, resourceId: { in: refIds }, relation: { in: [...NOTE_ROLES] } },
      select: { resourceId: true, relation: true, subjectType: true, subjectId: true },
    });
  }

  /** Есть ли у ресурса хотя бы один грант (значок «поделились» в списке) — батчем */
  async sharedFlags(refType: string, refIds: string[]): Promise<Set<string>> {
    if (!refIds.length) return new Set();
    const rows = await this.db.relationTuple.findMany({
      where: { resourceType: refType, resourceId: { in: refIds } },
      select: { resourceId: true },
      distinct: ['resourceId'],
    });
    return new Set(rows.map((r) => r.resourceId));
  }
}

/**
 * Считается ли авторство правом на объект в ЭТОМ пространстве.
 *
 * Рабочая заметка принадлежит организации, а не автору: человек, выбывший из
 * команды (увольнение, исключение, понижение до Подрядчика), теряет её вместе с
 * членством — иначе бывший сотрудник продолжал бы читать и править рабочие
 * заметки по прямой ссылке. В личном пространстве авторство ценно и без членства:
 * заметка, которую сосед создал в открытой ему папке, остаётся его.
 */
function authorCounts(scope: NoteScope): boolean {
  return scope.member || scope.space.ownerType === 'user';
}

function levels(granted: Map<string, string[]>): NoteLevelGrants {
  const manager = granted.get('manager') ?? [];
  const editor = [...new Set([...manager, ...(granted.get('editor') ?? [])])];
  const viewer = [...new Set([...editor, ...(granted.get('viewer') ?? [])])];
  return { viewer, editor, manager };
}

export function rank(access: NoteAccess): number {
  return access === 'owner' ? 100 : NOTE_ROLE_RANK[access];
}

export const EMPTY_NOTE_LEVELS = EMPTY_LEVELS;
