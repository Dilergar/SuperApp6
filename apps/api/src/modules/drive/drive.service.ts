import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DRIVE_LIMITS,
  DRIVE_NODE_REF_TYPE,
  DRIVE_SYSTEM_FOLDERS,
  WORKSPACE_ROLE_RANK,
  driveNameKey,
  driveNameWithSuffix,
  type DriveAccess,
  type DriveBreadcrumbDto,
  type DriveListQuery,
  type DriveNodeDto,
  type DriveNodeFileDto,
  type DriveOverviewDto,
  type DriveRole,
  type DriveSort,
  type DriveSortDir,
  type DriveSpaceDto,
  type DriveSystemFolderKey,
  type FileKind,
  type FileOwnerType,
  type FileScanStatus,
  type FileStatus,
} from '@superapp/shared';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { ShareLinksService } from '../../core/share-links/share-links.service';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveAccessService, type DriveGrants } from './drive-access.service';
import { DRIVE_PHOTO_JOB, DRIVE_ROLLUP_JOB } from './drive.constants';
import { DriveSearchService } from './drive-search.service';

type Tx = Prisma.TransactionClient;

export type DriveSpaceRow = {
  id: string;
  kind: string;
  ownerType: string;
  ownerId: string;
  rootId: string | null;
};

export interface ResolvedSpace {
  space: DriveSpaceRow;
  access: DriveAccess | null;
  grants: DriveGrants;
}

export type NodeRow = Prisma.DriveNodeGetPayload<Record<string, never>>;

/**
 * Запрос страницы детей папки — без адресации пространства: папка уже известна,
 * а право на неё проверил вызывающий. Тем же запросом ходит гостевой листинг по
 * ссылке наружу, где пользователя нет вовсе.
 */
export type DriveChildrenQuery = Pick<DriveListQuery, 'sort' | 'dir' | 'cursor' | 'limit' | 'foldersOnly'>;

/**
 * OmniDrive — слой имён и дерева поверх core/files.
 *
 * Движок файлов остаётся единственным владельцем байтов, квот, вариантов и антивируса;
 * Диск добавляет имя, папку, корзину и версии. Один и тот же FileObject живёт и
 * вложением в чате, и узлом на Диске — это две строки FileLink, поэтому байты не
 * копируются, квота не удваивается, а правка через core/docs видна во всех местах.
 */
@Injectable()
export class DriveService implements OnModuleInit {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly jobs: JobsService,
    private readonly acl: DriveAccessService,
    private readonly search: DriveSearchService,
    private readonly shareLinks: ShareLinksService,
  ) {}

  onModuleInit(): void {
    // Доступ к файлу наследуется от узла Диска. canEditContent объявлен ЯВНО: без него
    // движок откатился бы на canAttach, и право правки документа молча приравнялось бы
    // к праву класть файлы — а это разные вещи (см. core/docs).
    this.filesRegistry.register(
      DRIVE_NODE_REF_TYPE,
      {
        canView: (viewerId, nodeId) => this.hasNodeAccess(viewerId, nodeId, 'viewer'),
        canAttach: (userId, nodeId) => this.hasNodeAccess(userId, nodeId, 'editor'),
        canEditContent: (userId, nodeId) => this.hasNodeAccess(userId, nodeId, 'editor'),
      },
      // Профили не ограничиваем: Диск принимает всё, что движок вообще разрешил
      // загрузить (иначе «Сохранить на Диск» отваливалось бы на голосовых и фото лотов).
      {},
    );
  }

  // ============================================================
  // Пространства
  // ============================================================

  /**
   * Пространство создаётся лениво при первом обращении — паттерн getOrCreateBook
   * финансов. Гонку двух первых открытий разруливает unique (ownerType, ownerId, kind):
   * проигравший перечитывает победителя.
   */
  async getOrCreateSpace(ownerType: FileOwnerType, ownerId: string): Promise<DriveSpaceRow> {
    const kind = ownerType === 'user' ? 'personal' : 'workspace';
    const existing = await this.db.driveSpace.findUnique({
      where: { ownerType_ownerId_kind: { ownerType, ownerId, kind } },
    });
    if (existing) return existing;

    try {
      return await this.db.$transaction(async (tx) => {
        const space = await tx.driveSpace.create({ data: { kind, ownerType, ownerId } });
        const root = await tx.driveNode.create({
          data: {
            spaceId: space.id,
            kind: 'folder',
            parentId: null,
            name: ownerType === 'user' ? 'Мой диск' : 'Диск организации',
            nameKey: driveNameKey(ownerType === 'user' ? 'Мой диск' : 'Диск организации'),
            createdById: ownerType === 'user' ? ownerId : 'system',
            depth: 0,
            sortRank: 0,
            subtreeBytes: BigInt(0),
            subtreeFiles: 0,
          },
        });
        const updated = await tx.driveSpace.update({ where: { id: space.id }, data: { rootId: root.id } });

        if (ownerType === 'workspace') {
          // Диск организации по умолчанию — общий (модель Teams): вся команда видит и
          // добавляет, управляющие распоряжаются доступом. Оба гранта декларативны и
          // висят на КОРНЕ, поэтому наследуются вглубь сами и снимаются одной строкой.
          // Подрядчик сюда не попадает: его роль не проецируется в member.
          await this.acl.grantNode(root.id, 'editor', { type: 'workspace', id: ownerId, relation: 'member' }, tx);
          await this.acl.grantNode(root.id, 'manager', { type: 'workspace', id: ownerId, relation: 'manager' }, tx);
        }
        return updated;
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        return this.db.driveSpace.findUniqueOrThrow({
          where: { ownerType_ownerId_kind: { ownerType, ownerId, kind } },
        });
      }
      throw e;
    }
  }

  /**
   * Пространство, с которым работает вызывающий, и его права в нём — единственная
   * точка входа всех ручек Диска (паттерн resolveBook финансов).
   */
  async resolveSpace(
    userId: string,
    ref: { spaceId?: string; workspaceId?: string; parentId?: string },
    need: 'view' | 'edit' = 'view',
  ): Promise<ResolvedSpace> {
    let space: DriveSpaceRow;
    if (ref.spaceId) {
      const found = await this.db.driveSpace.findUnique({ where: { id: ref.spaceId } });
      if (!found) throw new NotFoundException('Диск не найден');
      space = found;
    } else if (ref.parentId) {
      // Папка сама называет своё пространство. Без этого «открыть чужую расшаренную
      // папку по ссылке» уводило бы в СВОЙ диск и падало «папка с другого диска»:
      // человек с законным доступом получал бы 400 вместо содержимого.
      const parent = await this.db.driveNode.findUnique({
        where: { id: ref.parentId },
        select: { spaceId: true },
      });
      if (!parent) throw new NotFoundException('Папка не найдена');
      space = await this.loadSpace(parent.spaceId);
    } else if (ref.workspaceId) {
      // Диск организации доступен только команде — Подрядчик отсекается рангом.
      const rank = await this.acl.workspaceRank(userId, ref.workspaceId);
      if (rank < WORKSPACE_ROLE_RANK.trainee) {
        throw new ForbiddenException('Вы не состоите в этой организации');
      }
      space = await this.getOrCreateSpace('workspace', ref.workspaceId);
    } else {
      space = await this.getOrCreateSpace('user', userId);
    }

    const access = await this.acl.spaceAccess(userId, space);
    const grants = await this.acl.grantsFor(userId);
    // Право видеть само пространство: либо владею, либо мне выдан хоть один его узел.
    if (!access) {
      const anyGrantHere = grants.viewer.length
        ? await this.db.driveNode.count({ where: { spaceId: space.id, id: { in: grants.viewer } } })
        : 0;
      if (!anyGrantHere) throw new ForbiddenException('Нет доступа к этому диску');
    }
    if (need === 'edit' && access !== 'owner' && !grants.editor.length) {
      throw new ForbiddenException('Нет прав на изменение');
    }
    return { space, access, grants };
  }

  async overview(userId: string, ref: { spaceId?: string; workspaceId?: string }): Promise<DriveOverviewDto> {
    const resolved = await this.resolveSpace(userId, ref);
    const { space } = resolved;
    const usage = await this.files.getUsageFor(space.ownerType as FileOwnerType, space.ownerId);
    const trashedCount = await this.db.driveNode.count({
      where: { spaceId: space.id, trashedAt: { not: null }, trashedRootId: null },
    });
    return {
      space: await this.serializeSpace(space, resolved.access),
      sharedWithMe: await this.sharedSpaces(userId, resolved.grants, space.id),
      bytesUsed: usage.bytesUsed,
      limitBytes: usage.limitBytes,
      filesCount: usage.filesCount,
      trashedCount,
    };
  }

  /** Пространства, куда зрителю дали доступ (не свои) */
  private async sharedSpaces(userId: string, grants: DriveGrants, exceptId: string): Promise<DriveSpaceDto[]> {
    if (!grants.viewer.length) return [];
    const rows = await this.db.driveNode.findMany({
      where: { id: { in: grants.viewer } },
      select: { spaceId: true },
      distinct: ['spaceId'],
    });
    const ids = rows.map((r) => r.spaceId).filter((id) => id !== exceptId);
    if (!ids.length) return [];
    const spaces = await this.db.driveSpace.findMany({ where: { id: { in: ids } } });
    const out: DriveSpaceDto[] = [];
    for (const s of spaces) {
      if (s.ownerType === 'user' && s.ownerId === userId) continue;
      out.push(await this.serializeSpace(s, await this.acl.spaceAccess(userId, s)));
    }
    return out;
  }

  async serializeSpace(space: DriveSpaceRow, access: DriveAccess | null): Promise<DriveSpaceDto> {
    let title = 'Мой диск';
    if (space.ownerType === 'workspace') {
      const ws = await this.db.workspace.findUnique({ where: { id: space.ownerId }, select: { name: true } });
      title = ws ? `Диск · ${ws.name}` : 'Диск организации';
    } else {
      const owner = await this.db.user.findUnique({
        where: { id: space.ownerId },
        select: { firstName: true, lastName: true },
      });
      title = owner ? `Диск · ${owner.firstName}${owner.lastName ? ` ${owner.lastName}` : ''}` : 'Мой диск';
    }
    return {
      id: space.id,
      kind: space.kind as DriveSpaceDto['kind'],
      ownerType: space.ownerType as FileOwnerType,
      ownerId: space.ownerId,
      rootId: space.rootId ?? '',
      title,
      access: access ?? 'viewer',
    };
  }

  // ============================================================
  // Права на узле (используются и резолвером движка файлов)
  // ============================================================

  async loadNode(nodeId: string): Promise<NodeRow> {
    const node = await this.db.driveNode.findUnique({ where: { id: nodeId } });
    if (!node) throw new NotFoundException('Объект не найден');
    return node;
  }

  async loadSpace(spaceId: string): Promise<DriveSpaceRow> {
    const space = await this.db.driveSpace.findUnique({ where: { id: spaceId } });
    if (!space) throw new NotFoundException('Диск не найден');
    return space;
  }

  spaceAccessOf(userId: string, space: DriveSpaceRow): Promise<DriveAccess | null> {
    return this.acl.spaceAccess(userId, space);
  }

  /** Права зрителя на узле: пространство + гранты на узле и предках */
  async nodeAccessOf(userId: string, node: NodeRow, grants?: DriveGrants): Promise<DriveAccess | null> {
    const space = await this.db.driveSpace.findUnique({ where: { id: node.spaceId } });
    if (!space) return null;
    const spaceAccess = await this.acl.spaceAccess(userId, space);
    const g = grants ?? (await this.acl.grantsFor(userId));
    return this.acl.nodeAccess(node, spaceAccess, g);
  }

  private async hasNodeAccess(userId: string, nodeId: string, need: DriveRole): Promise<boolean> {
    const node = await this.db.driveNode.findUnique({ where: { id: nodeId } });
    // Узел в корзине правами больше не делится: файл ещё жив (он может быть вложением
    // в чате), но «место на Диске» его уже не оправдывает.
    if (!node || node.trashedAt) return false;
    const access = await this.nodeAccessOf(userId, node);
    if (!access) return false;
    try {
      this.acl.assertAccess(access, need);
      return true;
    } catch {
      return false;
    }
  }

  /** Узел + права зрителя; бросает, если прав нет вовсе */
  async requireNode(
    userId: string,
    nodeId: string,
    need: DriveRole = 'viewer',
  ): Promise<{ node: NodeRow; access: DriveAccess; grants: DriveGrants }> {
    const node = await this.loadNode(nodeId);
    const grants = await this.acl.grantsFor(userId);
    const access = await this.nodeAccessOf(userId, node, grants);
    this.acl.assertAccess(access, need);
    return { node, access: access as DriveAccess, grants };
  }

  // ============================================================
  // Листинг
  // ============================================================

  /**
   * Листинг папки. Право проверяется у САМОЙ ПАПКИ один раз — дети наследуют его по
   * определению, поэтому в запрос детей массив грантов не идёт вовсе.
   *
   * «Папки вперёд» — это ведущий ключ сортировки (sort_rank), а не отдельная ветка
   * условий, и запрос идёт ДВУМЯ потоками (сначала папки, потом файлы). Так каждый
   * поток keyset'ится по одному направлению и ложится ровно на партиальный индекс;
   * смешанные направления в одном ORDER BY (папки по возрастанию, дата по убыванию)
   * заставили бы планировщик сортировать всю папку целиком.
   */
  async listNodes(userId: string, q: DriveListQuery): Promise<{ items: DriveNodeDto[]; nextCursor: string | null }> {
    const { space, access, grants } = await this.resolveSpace(userId, q);
    const parentId = q.parentId ?? space.rootId;
    if (!parentId) throw new NotFoundException('Диск не найден');

    const parent = await this.loadNode(parentId);
    if (parent.spaceId !== space.id) throw new BadRequestException('Папка из другого диска');
    if (parent.trashedAt) throw new NotFoundException('Папка удалена');
    const parentAccess = this.acl.nodeAccess(parent, access, grants);
    this.acl.assertAccess(parentAccess, 'viewer');

    const { rows, nextCursor } = await this.listChildrenOf(parentId, q);
    return { items: await this.serializeNodes(userId, rows), nextCursor };
  }

  /**
   * Страница детей папки БЕЗ проверки прав: их проверил вызывающий на самой папке,
   * дети наследуют доступ по определению. Выделено из listNodes, потому что тем же
   * keyset'ом ходит гостевой листинг по ссылке наружу (core/share-links), где
   * пользователя нет вовсе, а скоуп задаёт сама ссылка.
   */
  async listChildrenOf(
    parentId: string,
    q: DriveChildrenQuery,
  ): Promise<{ rows: NodeRow[]; nextCursor: string | null }> {
    const limit = q.limit ?? DRIVE_LIMITS.pageSize;
    const cursor = decodeCursor(q.cursor);
    const rows: NodeRow[] = [];

    // Поток 0 — папки, поток 1 — всё остальное.
    for (const rank of [0, 1] as const) {
      if (rows.length >= limit) break;
      if (cursor && cursor.r > rank) continue;
      if (q.foldersOnly && rank === 1) break;
      const after = cursor && cursor.r === rank ? cursor : null;
      const need = limit - rows.length + 1;
      rows.push(...(await this.fetchStream(parentId, rank, q.sort, q.dir, after, need)));
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { rows: page, nextCursor: hasMore && last ? encodeCursor(last, q.sort) : null };
  }

  private async fetchStream(
    parentId: string,
    sortRank: number,
    sort: DriveSort,
    dir: DriveSortDir,
    after: DecodedCursor | null,
    limit: number,
  ): Promise<NodeRow[]> {
    // Размер папки бывает НЕИЗВЕСТЕН (subtree_bytes = NULL — сентинел пересчёта, штатное
    // состояние сразу после любой загрузки). Такие идут в конец: «неизвестно» это не
    // «самая большая». Без явного NULLS LAST они попадали бы в начало (умолчание
    // Postgres для DESC), а курсор кодировал их как «0» — и следующая страница просила
    // бы `subtree_bytes < 0`, то есть НИЧЕГО: список молча обрывался на первой же
    // грязной папке.
    const orderBy: Prisma.DriveNodeOrderByWithRelationInput[] =
      sort === 'name'
        ? [{ name: dir }, { id: dir }]
        : sort === 'updated'
          ? [{ updatedAt: dir }, { id: dir }]
          : [{ subtreeBytes: { sort: dir, nulls: 'last' } }, { id: dir }];

    const where: Prisma.DriveNodeWhereInput = { parentId, sortRank, trashedAt: null };
    if (after) {
      // Классический keyset: «ключ строго дальше» ИЛИ «ключ тот же, id дальше».
      // Направление одно на весь поток, поэтому условие ложится на партиальный индекс.
      const op = dir === 'asc' ? 'gt' : 'lt';
      if (sort === 'size') {
        where.OR =
          after.k === null
            ? // Хвост уже начался: остаток — только неизвестные размеры.
              [{ subtreeBytes: null, id: { [op]: after.i } } as Prisma.DriveNodeWhereInput]
            : [
                { subtreeBytes: { [op]: BigInt(after.k) } } as Prisma.DriveNodeWhereInput,
                { subtreeBytes: BigInt(after.k), id: { [op]: after.i } } as Prisma.DriveNodeWhereInput,
                // …и сам хвост неизвестных, который идёт следом за всеми известными.
                { subtreeBytes: null } as Prisma.DriveNodeWhereInput,
              ];
      } else {
        const value = sort === 'name' ? (after.k as string) : new Date(after.k as string);
        const field = sort === 'name' ? 'name' : 'updatedAt';
        where.OR = [
          { [field]: { [op]: value } } as Prisma.DriveNodeWhereInput,
          { [field]: value, id: { [op]: after.i } } as Prisma.DriveNodeWhereInput,
        ];
      }
    }

    return this.db.driveNode.findMany({ where, orderBy, take: limit });
  }

  // ============================================================
  // Сериализация
  // ============================================================

  async serializeNodes(userId: string, rows: NodeRow[]): Promise<DriveNodeDto[]> {
    if (!rows.length) return [];
    const fileIds = rows.map((r) => r.fileId).filter((id): id is string => !!id);
    const [fileRows, views, stars, sharedOut] = await Promise.all([
      fileIds.length
        ? this.db.fileObject.findMany({
            where: { id: { in: fileIds } },
            select: {
              id: true,
              name: true,
              mime: true,
              kind: true,
              size: true,
              status: true,
              scanStatus: true,
              meta: true,
            },
          })
        : Promise.resolve([]),
      // Ссылки подписываются ОДНИМ батчем и едут в теле листинга (приём Slack/Discord):
      // иначе страница на 100 файлов означала бы 100 отдельных запросов за ссылкой.
      fileIds.length ? this.files.buildAttachmentViews(fileIds) : Promise.resolve(new Map()),
      this.db.driveStar.findMany({
        where: { userId, nodeId: { in: rows.map((r) => r.id) } },
        select: { nodeId: true },
      }),
      // Одним групповым запросом на всю страницу: «что из этого лежит наружу» — первый
      // вопрос, который задают, когда файл всплыл где-то не там, и до сих пор ответить
      // на него в списке было нечем.
      this.shareLinks.countActiveForRefs(
        DRIVE_NODE_REF_TYPE,
        rows.map((r) => r.id),
      ),
    ]);

    const byFile = new Map(fileRows.map((f) => [f.id, f]));
    const starred = new Set(stars.map((s) => s.nodeId));

    return rows.map((row) => {
      const raw = row.fileId ? byFile.get(row.fileId) : undefined;
      const view = row.fileId ? views.get(row.fileId) : undefined;
      const meta = (raw?.meta ?? null) as Record<string, unknown> | null;
      const file: DriveNodeFileDto | null = raw
        ? {
            id: raw.id,
            name: raw.name,
            mime: raw.mime,
            kind: raw.kind as FileKind,
            size: Number(raw.size),
            status: raw.status as FileStatus,
            scanStatus: raw.scanStatus as FileScanStatus,
            thumbUrl: view?.thumbUrl ?? view?.posterUrl ?? null,
            urlExpiresAt: view?.urlExpiresAt ?? null,
            width: view?.width ?? null,
            height: view?.height ?? null,
            durationMs: view?.durationMs ?? null,
            thumbhash: typeof meta?.thumbhash === 'string' ? (meta.thumbhash as string) : null,
          }
        : null;

      return {
        id: row.id,
        spaceId: row.spaceId,
        kind: row.kind as DriveNodeDto['kind'],
        parentId: row.parentId,
        name: row.name,
        createdById: row.createdById,
        depth: row.depth,
        systemKey: row.systemKey,
        file,
        subtreeBytes: row.subtreeBytes === null ? null : Number(row.subtreeBytes),
        subtreeFiles: row.subtreeFiles,
        takenAtLocal: row.takenAtLocal ? row.takenAtLocal.toISOString() : null,
        starred: starred.has(row.id),
        shareLinks: sharedOut.get(row.id) ?? 0,
        trashedAt: row.trashedAt ? row.trashedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async breadcrumbs(node: NodeRow): Promise<DriveBreadcrumbDto[]> {
    if (!node.ancestorIds.length) return [];
    const rows = await this.db.driveNode.findMany({
      where: { id: { in: node.ancestorIds } },
      select: { id: true, name: true, systemKey: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return node.ancestorIds.map((id) => byId.get(id)).filter((r): r is DriveBreadcrumbDto => !!r);
  }

  // ============================================================
  // Создание узлов
  // ============================================================

  /** Свободное имя в папке: «Отчёт.pdf» → «Отчёт (2).pdf» */
  async freeName(tx: Tx, parentId: string, wanted: string, suffix?: string): Promise<string> {
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = driveNameWithSuffix(wanted, attempt, attempt === 1 ? suffix : undefined);
      const clash = await tx.driveNode.count({
        where: { parentId, nameKey: driveNameKey(candidate), trashedAt: null },
      });
      if (!clash) return candidate;
    }
    throw new ConflictException('Слишком много объектов с таким именем');
  }

  async createFolder(userId: string, q: { spaceId?: string; workspaceId?: string; parentId?: string; name: string }): Promise<DriveNodeDto> {
    const { space, access, grants } = await this.resolveSpace(userId, q);
    const parentId = q.parentId ?? space.rootId;
    if (!parentId) throw new NotFoundException('Диск не найден');
    const parent = await this.loadNode(parentId);
    this.assertSameSpace(parent, space.id);
    this.acl.assertAccess(this.acl.nodeAccess(parent, access, grants), 'editor');
    if (parent.depth + 1 > DRIVE_LIMITS.maxDepth) {
      throw new BadRequestException(`Слишком глубокая вложенность (максимум ${DRIVE_LIMITS.maxDepth})`);
    }

    const created = await this.db.$transaction(async (tx) => {
      const name = await this.freeName(tx, parentId, q.name);
      const node = await tx.driveNode.create({
        data: {
          spaceId: space.id,
          kind: 'folder',
          parentId,
          name,
          nameKey: driveNameKey(name),
          createdById: userId,
          ancestorIds: [...parent.ancestorIds, parent.id],
          depth: parent.depth + 1,
          sortRank: 0,
          subtreeBytes: BigInt(0),
          subtreeFiles: 0,
        },
      });
      return node;
    });
    await this.search.index(created);
    return (await this.serializeNodes(userId, [created]))[0];
  }

  /**
   * Положить на Диск уже загруженный движком файл. Байты Диск не принимает: загрузка
   * идёт обычным путём core/files, сюда приезжает готовый fileId — так один файл может
   * лежать и в чате, и на Диске, оставаясь одним FileObject.
   */
  async attachFile(
    userId: string,
    q: { spaceId?: string; workspaceId?: string; parentId?: string; fileId: string; name?: string },
  ): Promise<DriveNodeDto> {
    const { space, access, grants } = await this.resolveSpace(userId, q);
    const parentId = q.parentId ?? space.rootId;
    if (!parentId) throw new NotFoundException('Диск не найден');
    const parent = await this.loadNode(parentId);
    this.assertSameSpace(parent, space.id);
    this.acl.assertAccess(this.acl.nodeAccess(parent, access, grants), 'editor');

    const node = await this.placeFile(userId, {
      spaceId: space.id,
      parentId,
      fileId: q.fileId,
      name: q.name,
      parentAncestors: [...parent.ancestorIds, parent.id],
      depth: parent.depth + 1,
    });
    return (await this.serializeNodes(userId, [node]))[0];
  }

  /**
   * Общий путь «файл → узел»: и ручное добавление, и авто-складывание файлов из
   * переписки.
   *
   * ПРАВО НА ФАЙЛ ПРОВЕРЯЕТСЯ ЗДЕСЬ, а не у вызывающего. Раньше проверки не было
   * вовсе: зная чужой `fileId` (а он остаётся у всех, кто когда-то имел доступ —
   * уволенный сотрудник, выкинутый из чата), человек прикладывал чужой файл к себе на
   * Диск и получал полный набор — прочитать, переписать через core/docs и уничтожить
   * у владельца везде (узел это ДОМ файла). Отзыв доступа переставал что-либо значить.
   *
   * Правило (ровно то, что обещает кнопка «Сохранить на Диск»):
   *   свой файл             → СВЯЗЬ, те же байты (один FileObject в чате и на Диске);
   *   чужой, но видимый мне → КОПИЯ на свою квоту (чтобы моё удаление не гасило чужое);
   *   невидимый             → 404.
   */
  async placeFile(
    userId: string,
    opts: {
      spaceId: string;
      parentId: string;
      fileId: string;
      name?: string;
      parentAncestors: string[];
      depth: number;
      tx?: Tx;
    },
  ): Promise<NodeRow> {
    let file = await this.db.fileObject.findUnique({
      where: { id: opts.fileId },
      select: { id: true, name: true, size: true, status: true, kind: true, uploaderId: true, ownerType: true, ownerId: true },
    });
    if (!file || file.status !== 'ready') throw new NotFoundException('Файл не найден или не готов');
    if (opts.depth > DRIVE_LIMITS.maxDepth) {
      throw new BadRequestException(`Слишком глубокая вложенность (максимум ${DRIVE_LIMITS.maxDepth})`);
    }

    // «Свой» — загрузил сам либо владею как личным файлом. Копии, сделанные Диском
    // (перенос между дисками, снимок версии), тоже свои: uploaderId у них — актор.
    const mine = file.uploaderId === userId || (file.ownerType === 'user' && file.ownerId === userId);
    if (!mine) {
      if (!(await this.files.canViewFile(userId, file.id))) throw new NotFoundException('Файл не найден');
      // Копия делает драйвер (на стороне хранилища), и она обязана идти ВНЕ чужой
      // транзакции: сетевой вызов внутри неё держал бы замки всё время загрузки.
      // Автоматические пути (укладка из переписки) сюда не попадают — там файл всегда
      // свой, — поэтому tx здесь означает ошибку вызывающего, а не рабочий случай.
      if (opts.tx) throw new ForbiddenException('Чужой файл нельзя положить этой операцией');
      const space = await this.loadSpace(opts.spaceId);
      const copy = await this.files.copyFile({
        fileId: file.id,
        actorId: userId,
        ownerType: space.ownerType as FileOwnerType,
        ownerId: space.ownerId,
        name: opts.name ?? file.name,
      });
      file = {
        id: copy.id,
        name: copy.name,
        size: BigInt(copy.size),
        status: 'ready',
        kind: copy.kind,
        uploaderId: userId,
        ownerType: space.ownerType,
        ownerId: space.ownerId,
      };
    }

    // Тот же файл дважды в ОДНОЙ папке не кладём — иначе «Сохранить на Диск», нажатое
    // дважды, размножало бы строки на одни байты. Проверка именно по папке, а не по
    // всему пространству: узел-двойник мог лежать в папке, которой человек не видит, и
    // ответ раскрывал бы её имя и путь.
    const already = await this.db.driveNode.findFirst({
      where: { parentId: opts.parentId, fileId: file.id, trashedAt: null },
    });
    if (already) return already;

    const run = async (tx: Tx): Promise<NodeRow> => {
      // Блокируем СТРОКУ файла и перечитываем статус уже под замком.
      //
      // Проверка выше сделана вне транзакции, и между ней и записью файл может быть
      // удалён соседом (человек прислал вложение и тут же удалил сообщение — это
      // секунды). Снимок нашей транзакции чужого удаления не увидит, и получилась бы
      // классическая аномалия записи: узел Диска, ссылающийся на мёртвый файл.
      // Замок строки сериализует нас с soft-delete движка: кто первый, того и правда.
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "file_objects" WHERE "id" = ${file.id} FOR UPDATE`;
      if (locked[0]?.status !== 'ready') throw new NotFoundException('Файл больше недоступен');

      const name = await this.freeName(tx, opts.parentId, opts.name ?? file.name);
      const node = await tx.driveNode.create({
        data: {
          spaceId: opts.spaceId,
          kind: 'file',
          parentId: opts.parentId,
          name,
          nameKey: driveNameKey(name),
          fileId: file.id,
          createdById: userId,
          ancestorIds: opts.parentAncestors,
          depth: opts.depth,
          sortRank: 1,
          // Размер файла лежит в том же поле, что и роллап папки: одна колонка кормит
          // и сортировку «по размеру», и арифметику пересчёта.
          subtreeBytes: file.size,
          subtreeFiles: 1,
        },
      });
      // Настоящая (не служебная) связь: она и делает Диск ДОМОМ файла — реап сирот
      // движка сносит приватный файл без единой связи через сутки.
      await this.files.linkSystemInTx(tx, {
        fileId: file.id,
        refType: DRIVE_NODE_REF_TYPE,
        refId: node.id,
        createdById: userId,
      });
      await this.markDirty(tx, opts.parentAncestors);
      // Джобы — В ТОЙ ЖЕ транзакции: узел появился ⇒ он будет посчитан и попадёт
      // в ленту «Фото»; откатились ⇒ джобов нет.
      await this.jobs.enqueue(tx, {
        type: DRIVE_ROLLUP_JOB,
        payload: { spaceId: opts.spaceId },
        uniqueKey: `drl:${opts.spaceId}`,
      });
      if (file.kind === 'image' || file.kind === 'video') {
        await this.jobs.enqueue(tx, {
          type: DRIVE_PHOTO_JOB,
          payload: { nodeId: node.id },
          uniqueKey: `dph:${node.id}`,
          // Конвейер картинки стартует сразу после загрузки — даём ему фору, чтобы
          // первая попытка не сгорела впустую.
          runAt: new Date(Date.now() + 5_000),
        });
      }
      return node;
    };

    const node = opts.tx ? await run(opts.tx) : await this.db.$transaction(run);
    await this.search.index(node);
    return node;
  }

  async rename(userId: string, nodeId: string, name: string): Promise<DriveNodeDto> {
    const { node } = await this.requireNode(userId, nodeId, 'editor');
    if (!node.parentId) throw new BadRequestException('Корень диска переименовать нельзя');
    if (node.systemKey) throw new BadRequestException('Системную папку переименовать нельзя');
    const updated = await this.db.$transaction(async (tx) => {
      const free = await this.freeName(tx, node.parentId as string, name);
      return tx.driveNode.update({
        where: { id: node.id },
        data: { name: free, nameKey: driveNameKey(free) },
      });
    });
    await this.search.index(updated);
    return (await this.serializeNodes(userId, [updated]))[0];
  }

  // ============================================================
  // Избранное и недавние — персональные пометки зрителя
  // ============================================================

  async setStar(userId: string, nodeId: string, on: boolean): Promise<void> {
    await this.requireNode(userId, nodeId, 'viewer');
    if (on) {
      await this.db.driveStar
        .create({ data: { userId, nodeId } })
        .catch((e: { code?: string }) => {
          if (e?.code !== 'P2002') throw e; // уже в избранном — не ошибка
        });
    } else {
      await this.db.driveStar.deleteMany({ where: { userId, nodeId } });
    }
  }

  /**
   * «Недавние» и «Избранное» — сквозные списки: узел мог лежать где угодно, и права
   * приходится перепроверять по каждому. Это дёшево (грант-сет берётся один раз), а
   * молча показать объект, доступ к которому уже отозвали, — нет.
   */
  async listStarred(userId: string): Promise<DriveNodeDto[]> {
    const stars = await this.db.driveStar.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: DRIVE_LIMITS.pageSize,
      select: { nodeId: true },
    });
    return this.visibleNodes(userId, stars.map((s) => s.nodeId));
  }

  async listRecent(userId: string): Promise<DriveNodeDto[]> {
    const rows = await this.db.driveRecent.findMany({
      where: { userId },
      orderBy: { openedAt: 'desc' },
      take: DRIVE_LIMITS.pageSize,
      select: { nodeId: true },
    });
    return this.visibleNodes(userId, rows.map((r) => r.nodeId));
  }

  async touchRecent(userId: string, nodeId: string): Promise<void> {
    await this.db.driveRecent
      .upsert({
        where: { userId_nodeId: { userId, nodeId } },
        create: { userId, nodeId },
        update: { openedAt: new Date() },
      })
      .catch(() => undefined);
  }

  private async visibleNodes(userId: string, nodeIds: string[]): Promise<DriveNodeDto[]> {
    if (!nodeIds.length) return [];
    const rows = await this.db.driveNode.findMany({ where: { id: { in: nodeIds }, trashedAt: null } });
    const grants = await this.acl.grantsFor(userId);
    const spaceAccess = new Map<string, DriveAccess | null>();
    const visible: NodeRow[] = [];
    for (const row of rows) {
      if (!spaceAccess.has(row.spaceId)) {
        const space = await this.db.driveSpace.findUnique({ where: { id: row.spaceId } });
        spaceAccess.set(row.spaceId, space ? await this.acl.spaceAccess(userId, space) : null);
      }
      if (this.acl.nodeAccess(row, spaceAccess.get(row.spaceId) ?? null, grants)) visible.push(row);
    }
    const order = new Map(nodeIds.map((id, i) => [id, i]));
    visible.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return this.serializeNodes(userId, visible);
  }

  // ============================================================
  // Системные папки
  // ============================================================

  /** Папка «Файлы из переписки» и подобные: создаётся лениво, не удаляется */
  async systemFolder(spaceId: string, key: DriveSystemFolderKey, tx?: Tx): Promise<NodeRow> {
    const client = tx ?? this.db;
    const existing = await client.driveNode.findFirst({ where: { spaceId, systemKey: key, trashedAt: null } });
    if (existing) return existing;

    const space = await client.driveSpace.findUniqueOrThrow({ where: { id: spaceId } });
    if (!space.rootId) throw new NotFoundException('У диска нет корня');
    const root = await client.driveNode.findUniqueOrThrow({ where: { id: space.rootId } });
    const wanted = DRIVE_SYSTEM_FOLDERS[key].name;

    const create = async (c: Tx): Promise<NodeRow> => {
      const name = await this.freeName(c, root.id, wanted);
      return c.driveNode.create({
        data: {
          spaceId,
          kind: 'folder',
          parentId: root.id,
          name,
          nameKey: driveNameKey(name),
          createdById: 'system',
          ancestorIds: [root.id],
          depth: 1,
          sortRank: 0,
          systemKey: key,
          subtreeBytes: BigInt(0),
          subtreeFiles: 0,
        },
      });
    };

    try {
      return tx ? await create(tx) : await this.db.$transaction(create);
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        return client.driveNode.findFirstOrThrow({ where: { spaceId, systemKey: key, trashedAt: null } });
      }
      throw e;
    }
  }

  // ============================================================
  // Служебное
  // ============================================================

  assertSameSpace(node: { spaceId: string }, spaceId: string): void {
    if (node.spaceId !== spaceId) throw new BadRequestException('Объект из другого диска');
  }

  /**
   * Пометить предков «пересчитать». Сентинел (null) вместо арифметики на месте: под
   * массовым перемещением или удалением поддерева инкременты разъезжаются, а сентинел
   * всегда сходится — джоб и ночная сверка досчитают.
   */
  async markDirty(tx: Tx, ancestorIds: string[]): Promise<void> {
    if (!ancestorIds.length) return;
    await tx.driveNode.updateMany({
      where: { id: { in: ancestorIds }, kind: 'folder' },
      data: { subtreeBytes: null, subtreeFiles: null },
    });
  }

  /** Сколько ЕЩЁ мест ссылается на файл (чат, задача) — предупреждение перед удалением */
  async usedElsewhere(fileId: string | null): Promise<number> {
    if (!fileId) return 0;
    const links = await this.files.listLinksOfFile(fileId);
    return links.filter((l) => l.refType !== DRIVE_NODE_REF_TYPE).length;
  }
}

// ============================================================
// Курсор листинга
// ============================================================

interface DecodedCursor {
  /** Поток: 0 — папки, 1 — файлы */
  r: number;
  /**
   * Значение ключа сортировки последней отданной строки. `null` — только у размера и
   * означает «размер ещё не посчитан»: это отдельная фаза в хвосте, а не ноль.
   */
  k: string | null;
  i: string;
}

function encodeCursor(row: NodeRow, sort: DriveSort): string {
  const k =
    sort === 'name'
      ? row.name
      : sort === 'updated'
        ? row.updatedAt.toISOString()
        : row.subtreeBytes === null
          ? null
          : String(row.subtreeBytes);
  return Buffer.from(JSON.stringify({ r: row.sortRank, k, i: row.id })).toString('base64url');
}

function decodeCursor(raw?: string): DecodedCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as DecodedCursor;
    if (typeof parsed?.r !== 'number' || typeof parsed?.i !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
