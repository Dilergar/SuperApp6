import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DRIVE_LIMITS, DRIVE_NODE_REF_TYPE, WORKSPACE_ROLE_RANK, driveNameKey } from '@superapp/shared';
import { FilesService } from '../../core/files/files.service';
import { ShareLinksService } from '../../core/share-links/share-links.service';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveAccessService } from './drive-access.service';
import { DriveJobs } from './drive.jobs';
import { DriveSearchService } from './drive-search.service';
import { DriveService } from './drive.service';

type Tx = Prisma.TransactionClient;
type NodeRow = Prisma.DriveNodeGetPayload<Record<string, never>>;

/**
 * Дерево Диска: перемещение, корзина, окончательное удаление.
 *
 * Все перестроения предков идут ОДНИМ UPDATE по GIN-индексу `ancestor_ids`, а не
 * обходом строк: у папки может быть десятки тысяч потомков, и построчный рекурсивный
 * апдейт превратил бы обычное перетаскивание в минутную операцию.
 */
@Injectable()
export class DriveTreeService {
  private readonly logger = new Logger(DriveTreeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly acl: DriveAccessService,
    private readonly drive: DriveService,
    private readonly jobs: DriveJobs,
    private readonly search: DriveSearchService,
    private readonly shareLinks: ShareLinksService,
  ) {}

  // ============================================================
  // Перемещение
  // ============================================================

  /**
   * Перенос узлов в другую папку ТОГО ЖЕ пространства.
   *
   * Гонка «два человека одновременно тащат A в B и B в A» даёт цикл, после которого
   * ветка дерева отваливается навсегда и её не видно ни из корня, ни из корзины.
   * Поэтому проверка отсутствия цикла и сама перестановка идут под advisory-локом
   * ПРОСТРАНСТВА и в одной транзакции: проверить до лока — значит проверить
   * состояние, которого к моменту записи уже нет.
   *
   * Права на дерево при этом ведут себя как в Google Drive и достаются бесплатно:
   * унаследованное от старых предков теряется (предки сменились), прямые гранты на
   * самом узле переезжают вместе с ним.
   */
  async move(userId: string, ids: string[], targetParentId?: string): Promise<number> {
    const nodes = await this.db.driveNode.findMany({ where: { id: { in: ids }, trashedAt: null } });
    if (!nodes.length) throw new NotFoundException('Объекты не найдены');
    const spaceId = nodes[0].spaceId;
    if (nodes.some((n) => n.spaceId !== spaceId)) {
      throw new BadRequestException('Все объекты должны быть с одного диска');
    }
    if (nodes.some((n) => n.systemKey)) {
      throw new BadRequestException('Системную папку переносить нельзя');
    }

    const space = await this.db.driveSpace.findUniqueOrThrow({ where: { id: spaceId } });
    const spaceAccess = await this.acl.spaceAccess(userId, space);
    const grants = await this.acl.grantsFor(userId);
    for (const n of nodes) this.acl.assertAccess(this.acl.nodeAccess(n, spaceAccess, grants), 'editor');

    const parentId = targetParentId ?? space.rootId;
    if (!parentId) throw new NotFoundException('Диск не найден');

    const movedIds: string[] = [];
    const result = await this.db.$transaction(async (tx) => {
      await this.lockSpace(tx, spaceId);

      const target = await tx.driveNode.findUnique({ where: { id: parentId } });
      if (!target || target.trashedAt) throw new NotFoundException('Папка назначения не найдена');
      if (target.kind !== 'folder') throw new BadRequestException('Переносить можно только в папку');
      if (target.spaceId !== spaceId) throw new BadRequestException('Папка назначения на другом диске');
      this.acl.assertAccess(this.acl.nodeAccess(target, spaceAccess, grants), 'editor');

      let moved = 0;
      for (const id of ids) {
        // Перечитываем ПОД локом: соседний перенос мог уже сдвинуть узел.
        const node = await tx.driveNode.findUnique({ where: { id } });
        if (!node || node.trashedAt || node.spaceId !== spaceId) continue;
        if (node.parentId === parentId) continue;
        if (!node.parentId) throw new BadRequestException('Корень переносить нельзя');

        // Цикл: нельзя положить папку внутрь себя или своего потомка.
        if (target.id === node.id || target.ancestorIds.includes(node.id)) {
          throw new BadRequestException('Нельзя переместить папку внутрь самой себя');
        }

        const newAnc = [...target.ancestorIds, target.id];
        const newDepth = newAnc.length;
        const delta = newDepth - node.depth;
        const subtreeMax = await this.subtreeMaxDepth(tx, node.id, node.depth);
        if (subtreeMax + delta > DRIVE_LIMITS.maxDepth) {
          throw new BadRequestException(`Слишком глубокая вложенность (максимум ${DRIVE_LIMITS.maxDepth})`);
        }

        const oldAnc = node.ancestorIds;
        const name = await this.drive.freeName(tx, parentId, node.name);
        await tx.driveNode.update({
          where: { id: node.id },
          data: { parentId, ancestorIds: newAnc, depth: newDepth, name, nameKey: driveNameKey(name) },
        });

        // Потомки: у каждого меняется только «голова» массива предков — хвост (путь от
        // перемещённого узла вниз) остаётся как был. Один UPDATE вместо обхода.
        if (node.kind === 'folder') {
          await tx.$executeRaw`
            UPDATE "drive_nodes"
               SET "ancestor_ids" = ${newAnc}::text[] || "ancestor_ids"[${oldAnc.length + 1}:],
                   "depth" = "depth" + ${delta}
             WHERE "ancestor_ids" @> ARRAY[${node.id}]::text[]`;
        }

        await this.drive.markDirty(tx, [...oldAnc, ...newAnc]);
        movedIds.push(node.id);
        moved++;
      }
      return moved;
    });

    // Переезд может ПЕРЕИМЕНОВАТЬ объект (в целевой папке имя было занято), а витрина
    // поиска об этом не узнала бы — и глобальный поиск ещё долго показывал бы старое имя.
    if (movedIds.length) {
      const rows = await this.db.driveNode.findMany({ where: { id: { in: movedIds } } });
      for (const row of rows) await this.search.index(row);
    }
    return result;
  }

  private async subtreeMaxDepth(tx: Tx, nodeId: string, fallback: number): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ max: number | null }>>`
      SELECT MAX("depth")::int AS max FROM "drive_nodes"
       WHERE "ancestor_ids" @> ARRAY[${nodeId}]::text[]`;
    return rows[0]?.max ?? fallback;
  }

  /**
   * Advisory-лок пространства на время транзакции. hashtext даёт int4, что для
   * pg_advisory_xact_lock(bigint) достаточно: коллизия двух пространств означает
   * лишь лишнюю сериализацию, а не ошибку.
   */
  private async lockSpace(tx: Tx, spaceId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${spaceId}))`;
  }

  // ============================================================
  // Копирование
  // ============================================================

  /**
   * Копия объектов — в том числе в ДРУГОЕ пространство (личное ↔ организации).
   *
   * Между пространствами это всегда именно копия, а не перенос: у движка файлов нет
   * смены владельца, а квота считается владельцу. Оригинал остаётся на месте — так
   * решил продукт, и кнопка честно называется «Копировать».
   *
   * Файл копируется сразу (на стороне хранилища, байты через приложение не идут),
   * папка — узел создаётся сразу, а содержимое доезжает джобом: копия папки с
   * тысячей файлов не должна держать HTTP-запрос.
   */
  async copy(
    userId: string,
    ids: string[],
    ref: { spaceId?: string; workspaceId?: string; parentId?: string },
  ): Promise<{ copied: number; queued: number }> {
    const { space, access, grants } = await this.drive.resolveSpace(userId, ref);
    const parentId = ref.parentId ?? space.rootId;
    if (!parentId) throw new NotFoundException('Диск не найден');
    const target = await this.drive.loadNode(parentId);
    this.drive.assertSameSpace(target, space.id);
    this.acl.assertAccess(this.acl.nodeAccess(target, access, grants), 'editor');

    const sources = await this.db.driveNode.findMany({ where: { id: { in: ids }, trashedAt: null } });
    if (!sources.length) throw new NotFoundException('Объекты не найдены');

    let copied = 0;
    let queued = 0;
    for (const source of sources) {
      // Читать исходник вправе не тот же человек, что пишет в назначение, — проверяем
      // отдельно: иначе «скопировать к себе» стало бы способом вынести чужое.
      const srcSpace = await this.drive.loadSpace(source.spaceId);
      const srcAccess = this.acl.nodeAccess(source, await this.acl.spaceAccess(userId, srcSpace), grants);
      this.acl.assertAccess(srcAccess, 'viewer');
      if (source.id === target.id || target.ancestorIds.includes(source.id)) {
        throw new BadRequestException('Нельзя скопировать папку внутрь самой себя');
      }

      if (source.kind === 'folder') {
        const name = await this.db.$transaction((tx) => this.drive.freeName(tx, target.id, source.name));
        const created = await this.db.driveNode.create({
          data: {
            spaceId: space.id,
            kind: 'folder',
            parentId: target.id,
            name,
            nameKey: driveNameKey(name),
            createdById: userId,
            ancestorIds: [...target.ancestorIds, target.id],
            depth: target.depth + 1,
            sortRank: 0,
            subtreeBytes: BigInt(0),
            subtreeFiles: 0,
          },
        });
        await this.search.index(created);
        await this.jobs.enqueueCopy(source.id, created.id, userId);
        queued++;
        continue;
      }

      if (!source.fileId) continue;
      const copyFile = await this.files.copyFile({
        fileId: source.fileId,
        actorId: userId,
        ownerType: space.ownerType as 'user' | 'workspace',
        ownerId: space.ownerId,
        name: source.name,
      });
      await this.drive.placeFile(userId, {
        spaceId: space.id,
        parentId: target.id,
        fileId: copyFile.id,
        name: source.name,
        parentAncestors: [...target.ancestorIds, target.id],
        depth: target.depth + 1,
      });
      copied++;
    }
    return { copied, queued };
  }

  // ============================================================
  // Корзина
  // ============================================================

  /**
   * В корзину — вместе с поддеревом. Явно удалённый узел помечается
   * `trashed_root_id = NULL`, его потомки — id этого узла: так корзина показывает
   * «одну удалённую папку», а не тысячу файлов внутри неё, а восстановление возвращает
   * ровно то, что человек удалял.
   *
   * Файл при этом ЖИВ: он мог быть вложением в чате, и вложение обязано работать до
   * окончательного удаления.
   */
  async trash(userId: string, ids: string[]): Promise<number> {
    const nodes = await this.db.driveNode.findMany({ where: { id: { in: ids }, trashedAt: null } });
    if (!nodes.length) return 0;
    if (nodes.some((n) => n.systemKey)) throw new BadRequestException('Системную папку удалить нельзя');
    if (nodes.some((n) => !n.parentId)) throw new BadRequestException('Корень диска удалить нельзя');

    const grants = await this.acl.grantsFor(userId);
    const spaces = new Map<string, Awaited<ReturnType<typeof this.acl.spaceAccess>>>();
    for (const n of nodes) {
      if (!spaces.has(n.spaceId)) {
        const space = await this.db.driveSpace.findUniqueOrThrow({ where: { id: n.spaceId } });
        spaces.set(n.spaceId, await this.acl.spaceAccess(userId, space));
      }
      this.acl.assertAccess(this.acl.nodeAccess(n, spaces.get(n.spaceId) ?? null, grants), 'editor');
    }

    const now = new Date();
    return this.db.$transaction(async (tx) => {
      let count = 0;
      for (const node of nodes) {
        const hit = await tx.driveNode.updateMany({
          where: { id: node.id, trashedAt: null },
          data: { trashedAt: now, trashedRootId: null },
        });
        if (!hit.count) continue;
        await tx.driveNode.updateMany({
          where: { ancestorIds: { has: node.id }, trashedAt: null },
          data: { trashedAt: now, trashedRootId: node.id },
        });
        await this.drive.markDirty(tx, node.ancestorIds);
        count++;
      }
      return count;
    }).then(async (count) => {
      // Из поиска убираем сразу, вместе с поддеревом: находить то, что человек
      // только что выбросил в корзину, — худший вид «умного» поиска.
      for (const node of nodes) {
        const subtree = await this.db.driveNode.findMany({
          where: { OR: [{ id: node.id }, { ancestorIds: { has: node.id } }] },
          select: { id: true },
        });
        await this.search.removeMany(subtree.map((n) => n.id));
      }
      return count;
    });
  }

  /**
   * Из корзины обратно. Два случая, оба обязаны быть обработаны, иначе восстановление
   * молча теряет объект: родителя могли удалить насовсем (кладём в корень) и имя могло
   * оказаться занятым, пока объект лежал в корзине (даём суффикс).
   */
  async restore(userId: string, ids: string[]): Promise<number> {
    const nodes = await this.db.driveNode.findMany({
      where: { id: { in: ids }, trashedAt: { not: null }, trashedRootId: null },
    });
    if (!nodes.length) throw new NotFoundException('В корзине ничего не найдено');

    const grants = await this.acl.grantsFor(userId);
    let restored = 0;
    for (const node of nodes) {
      const space = await this.db.driveSpace.findUniqueOrThrow({ where: { id: node.spaceId } });
      const spaceAccess = await this.acl.spaceAccess(userId, space);
      this.acl.assertAccess(this.acl.nodeAccess(node, spaceAccess, grants), 'editor');

      await this.db.$transaction(async (tx) => {
        await this.lockSpace(tx, node.spaceId);
        const parent = node.parentId
          ? await tx.driveNode.findUnique({ where: { id: node.parentId } })
          : null;
        const alive = parent && !parent.trashedAt ? parent : null;
        const home = alive ?? (await tx.driveNode.findUniqueOrThrow({ where: { id: space.rootId as string } }));

        const name = await this.drive.freeName(tx, home.id, node.name, 'восстановлен');
        const newAnc = [...home.ancestorIds, home.id];
        const delta = newAnc.length - node.depth;
        await tx.driveNode.update({
          where: { id: node.id },
          data: {
            trashedAt: null,
            trashedRootId: null,
            parentId: home.id,
            ancestorIds: newAnc,
            depth: newAnc.length,
            name,
            nameKey: driveNameKey(name),
          },
        });
        await tx.driveNode.updateMany({
          where: { trashedRootId: node.id },
          data: { trashedAt: null, trashedRootId: null },
        });
        if (delta !== 0 || alive === null) {
          const oldAnc = node.ancestorIds;
          await tx.$executeRaw`
            UPDATE "drive_nodes"
               SET "ancestor_ids" = ${newAnc}::text[] || "ancestor_ids"[${oldAnc.length + 1}:],
                   "depth" = "depth" + ${delta}
             WHERE "ancestor_ids" @> ARRAY[${node.id}]::text[]`;
        }
        await this.drive.markDirty(tx, newAnc);
      });
      const subtree = await this.db.driveNode.findMany({
        where: { OR: [{ id: node.id }, { ancestorIds: { has: node.id } }], trashedAt: null },
      });
      for (const n of subtree) await this.search.index(n);
      restored++;
    }
    return restored;
  }

  // ============================================================
  // Окончательное удаление
  // ============================================================

  /**
   * Удалить навсегда. Диск — ДОМ файла (модель Google Drive и Teams): вместе с узлом
   * гаснут и байты, поэтому вложение в чате, которое ссылалось на этот файл, покажет
   * «файл удалён». До этого момента (корзина, 30 дней) вложение работает как обычно —
   * именно поэтому корзина занимает место.
   *
   * Порядок важен: сначала снимаем гранты (tuples внешними ключами не связаны и
   * пережили бы узел), потом убиваем файлы, потом строки.
   */
  async purge(userId: string | null, ids: string[]): Promise<number> {
    const roots = await this.db.driveNode.findMany({ where: { id: { in: ids } } });
    if (!roots.length) return 0;

    if (userId) {
      const grants = await this.acl.grantsFor(userId);
      for (const n of roots) {
        if (n.systemKey) throw new BadRequestException('Системную папку удалить нельзя');
        if (!n.parentId) throw new BadRequestException('Корень диска удалить нельзя');
        const space = await this.db.driveSpace.findUniqueOrThrow({ where: { id: n.spaceId } });
        const access = this.acl.nodeAccess(n, await this.acl.spaceAccess(userId, space), grants);
        this.acl.assertAccess(access, 'editor');

        // На диске организации права «править» для НЕОБРАТИМОГО удаления мало: корень
        // раздаёт editor всей команде (`@workspace#member`), то есть любой Стажёр мог
        // одним запросом навсегда стереть рабочие файлы — вместе с байтами во всех
        // чатах и задачах, где на них ссылались. Корзина остаётся всем: выбросить туда
        // может редактор, а вот вынести из неё насовсем — только управляющий.
        if (space.ownerType === 'workspace') {
          const rank = await this.acl.workspaceRank(userId, space.ownerId);
          if (rank < WORKSPACE_ROLE_RANK.manager) {
            throw new ForbiddenException(
              'Удалить навсегда файлы организации может только управляющий — остальные удаляют в корзину',
            );
          }
        }
      }
    }

    let purged = 0;
    for (const root of roots) {
      const subtree = await this.db.driveNode.findMany({
        where: { OR: [{ id: root.id }, { ancestorIds: { has: root.id } }] },
        select: { id: true, fileId: true },
      });
      const nodeIds = subtree.map((n) => n.id);
      // Снимки версий тоже уходят вместе с узлом — иначе их байты и квота остались бы
      // висеть навсегда: строки DriveNodeVersion умрут каскадом, а FileObject нет.
      const versionFileIds = await this.versionFileIds(nodeIds);
      const fileIds = [
        ...new Set([...subtree.map((n) => n.fileId).filter((f): f is string => !!f), ...versionFileIds]),
      ];

      await this.acl.revokeAllOn(nodeIds);
      // Связи снимаем ЯВНО: FileLink каскадится за файлом, но не за узлом, и осиротевшая
      // строка со ссылкой на мёртвый узел навсегда защищала бы файл от реапа сирот.
      await this.files.unlinkAllForRefs(DRIVE_NODE_REF_TYPE, nodeIds).catch(() => undefined);
      // Гостевые ссылки — такие же висячие гранты, только наружу: строка share_links
      // внешним ключом не связана и пережила бы узел. Отзываем и на корне, и на всех
      // потомках. Корзину при этом НЕ трогаем: оттуда объект возвращается, и ссылка
      // обязана ожить вместе с ним (её на время приостанавливает резолвер).
      await this.shareLinks.revokeAllForRefs(null, DRIVE_NODE_REF_TYPE, nodeIds).catch(() => undefined);
      for (const fileId of fileIds) {
        // Файл гаснет ВЕЗДЕ — это и есть «Диск дом файла». Ошибка одного файла не
        // должна оставить дерево наполовину удалённым: логируем и идём дальше, ночная
        // сверка движка приберёт байты по своим правилам.
        await this.files.systemDeleteFile(fileId).catch((err: unknown) => {
          this.logger.warn(`не удалось удалить файл ${fileId}: ${err instanceof Error ? err.message : err}`);
        });
      }
      // Каскад по parent_id снял бы потомков и сам, но явное удаление по списку
      // не зависит от того, остались ли строки согласованными после сбоя выше.
      await this.db.driveNode.deleteMany({ where: { id: { in: nodeIds } } });
      await this.search.removeMany(nodeIds);
      await this.db.$transaction((tx) => this.drive.markDirty(tx, root.ancestorIds));
      purged++;
    }
    return purged;
  }

  /**
   * Список корзины пространства (только явно удалённые узлы).
   *
   * Курсор — ПАРА (время удаления, id). Одного времени мало: удаление пачки ставит
   * всем объектам ровно один `now`, и курсор «строго раньше» перепрыгивал бы через
   * весь остаток этой пачки. По той же причине страница и её курсор считаются по СЫРЫМ
   * строкам, а не по отфильтрованным правами: иначе отброшенный хвост уводил бы обход
   * не туда, и часть корзины становилась недостижимой.
   */
  async listTrash(
    userId: string,
    ref: { spaceId?: string; workspaceId?: string },
    opts: { cursor?: string; limit?: number },
  ): Promise<{ items: NodeRow[]; nextCursor: string | null }> {
    const { space, access, grants } = await this.drive.resolveSpace(userId, ref);
    const limit = opts.limit ?? DRIVE_LIMITS.pageSize;
    const after = decodeTrashCursor(opts.cursor);
    const where: Prisma.DriveNodeWhereInput = {
      spaceId: space.id,
      trashedRootId: null,
      trashedAt: { not: null },
    };
    if (after) {
      where.OR = [
        { trashedAt: { lt: after.t } },
        { trashedAt: after.t, id: { lt: after.i } },
      ];
    }
    const rows = await this.db.driveNode.findMany({
      where,
      orderBy: [{ trashedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const raw = hasMore ? rows.slice(0, limit) : rows;
    const lastRaw = raw[raw.length - 1];
    // Корзина показывает только то, что зритель вправе видеть: удалённый узел
    // сохраняет своих предков, поэтому обычная проверка наследования работает.
    const items = raw.filter((r) => this.acl.nodeAccess(r, access, grants) !== null);
    return { items, nextCursor: hasMore && lastRaw ? encodeTrashCursor(lastRaw) : null };
  }

  /** Крон: узлы, пролежавшие в корзине дольше ретеншна */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - DRIVE_LIMITS.trashRetentionDays * 86_400_000);
    const due = await this.db.driveNode.findMany({
      where: { trashedRootId: null, trashedAt: { lt: cutoff } },
      select: { id: true },
      take: DRIVE_LIMITS.purgeBatch,
    });
    if (!due.length) return 0;
    return this.purge(null, due.map((d) => d.id));
  }

  private async versionFileIds(nodeIds: string[]): Promise<string[]> {
    if (!nodeIds.length) return [];
    const rows = await this.db.driveNodeVersion.findMany({
      where: { nodeId: { in: nodeIds } },
      select: { fileId: true },
    });
    return rows.map((r) => r.fileId);
  }
}

// ============================================================
// Курсор корзины: пара (время удаления, id)
// ============================================================

function encodeTrashCursor(row: { trashedAt: Date | null; id: string }): string {
  return Buffer.from(
    JSON.stringify({ t: row.trashedAt?.toISOString() ?? null, i: row.id }),
  ).toString('base64url');
}

function decodeTrashCursor(raw?: string): { t: Date; i: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t: string; i: string };
    if (typeof parsed?.t !== 'string' || typeof parsed?.i !== 'string') return null;
    const t = new Date(parsed.t);
    return Number.isNaN(t.getTime()) ? null : { t, i: parsed.i };
  } catch {
    return null;
  }
}
