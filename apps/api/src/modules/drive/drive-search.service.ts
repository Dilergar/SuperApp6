import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DRIVE_NODE_REF_TYPE, type SearchResultItem } from '@superapp/shared';
import { SearchRegistry } from '../../core/search/search.registry';
import { SearchProjectionService } from '../../core/search/search-projection.service';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveAccessService } from './drive-access.service';

interface DriveHitRow {
  id: string;
  name: string;
  kind: string;
  spaceId: string;
  body: string | null;
  updatedAt: Date;
  score: number;
}

/**
 * Поиск по Диску — провайдер движка core/search.
 *
 * Права режутся В SQL тем же предикатом, что и листинг («владелец пространства ИЛИ
 * узел/предок в выданном наборе»), а не пост-фильтром по результату: иначе страница
 * из 30 совпадений превращалась бы в 3 после фильтрации, и «показать ещё» врало бы.
 * Тот же приём, что у поиска сообщений с его JOIN на chat_members.
 */
@Injectable()
export class DriveSearchService implements OnModuleInit {
  private readonly logger = new Logger(DriveSearchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: SearchRegistry,
    private readonly projection: SearchProjectionService,
    private readonly acl: DriveAccessService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: DRIVE_NODE_REF_TYPE,
      label: 'Диск',
      search: (viewerId, query, opts) => this.search(viewerId, query, opts),
    });
  }

  // ============================================================
  // Индексация
  // ============================================================

  /** Узел появился/переименован — обновляем витрину поиска (best-effort) */
  async index(node: {
    id: string;
    name: string;
    spaceId: string;
    kind: string;
    updatedAt: Date;
    trashedAt: Date | null;
  }): Promise<void> {
    try {
      // Удалённое в корзину из поиска убираем сразу: находить то, что человек только
      // что выбросил, — худший вид «умного» поиска.
      if (node.trashedAt) {
        await this.projection.remove(DRIVE_NODE_REF_TYPE, node.id);
        return;
      }
      await this.projection.upsert({
        sourceType: DRIVE_NODE_REF_TYPE,
        sourceId: node.id,
        url: `/drive/n/${node.id}`,
        itemCreatedAt: node.updatedAt,
        title: node.name,
        body: null,
      });
    } catch (err) {
      this.logger.warn(`индексация узла ${node.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async remove(nodeId: string): Promise<void> {
    await this.projection.remove(DRIVE_NODE_REF_TYPE, nodeId).catch(() => undefined);
  }

  async removeMany(nodeIds: string[]): Promise<void> {
    for (const id of nodeIds) await this.remove(id);
  }

  // ============================================================
  // Поиск
  // ============================================================

  private async search(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    // Поиск-в-чате Диска не касается: у него своя область.
    if (opts.chatId) return { items: [] };

    const limit = Math.min(opts.limit, 50);
    const grants = await this.acl.grantsFor(viewerId);
    // Свои пространства — предикат схлопывается в «всё видно» и идёт по btree.
    const ownSpaces = await this.db.driveSpace.findMany({
      where: { ownerType: 'user', ownerId: viewerId },
      select: { id: true },
    });
    const ownSpaceIds = ownSpaces.map((s) => s.id);
    if (!ownSpaceIds.length && !grants.viewer.length) return { items: [] };

    const tsq = Prisma.sql`websearch_to_tsquery('russian', ${query})`;
    const granted = Prisma.sql`${grants.viewer}::text[]`;
    const visible = Prisma.sql`(
      n."space_id" = ANY(${ownSpaceIds}::text[])
      OR n."id" = ANY(${granted})
      OR n."ancestor_ids" && ${granted}
    )`;

    const rows = await this.db.$transaction([
      this.db.$executeRaw`SET LOCAL pg_trgm.word_similarity_threshold = 0.4`,
      this.db.$queryRaw<DriveHitRow[]>(Prisma.sql`
        SELECT n."id" AS "id", n."name" AS "name", n."kind" AS "kind", n."space_id" AS "spaceId",
               sd."body" AS "body", n."updated_at" AS "updatedAt",
               (ts_rank(sd.search_vector, ${tsq}) * 4 + word_similarity(${query}, sd.title))::float8 AS "score"
          FROM "search_documents" sd
          JOIN "drive_nodes" n ON n."id" = sd."source_id"
         WHERE sd."source_type" = ${DRIVE_NODE_REF_TYPE}
           AND n."trashed_at" IS NULL
           AND ${visible}
           AND (sd.search_vector @@ ${tsq} OR ${query} <% sd.title)
         ORDER BY (ts_rank(sd.search_vector, ${tsq}) * 4 + word_similarity(${query}, sd.title)) DESC,
                  n."updated_at" DESC
         LIMIT ${limit}
      `),
    ]);
    const hits = (rows[1] as DriveHitRow[]) ?? [];

    const items: SearchResultItem[] = hits.map((h) => ({
      type: DRIVE_NODE_REF_TYPE,
      id: h.id,
      title: h.name,
      snippet: h.kind === 'folder' ? 'Папка' : 'Файл',
      url: `/drive/n/${h.id}`,
      chatId: null,
      messageId: null,
      avatar: null,
      createdAt: h.updatedAt ? h.updatedAt.toISOString() : null,
      score: h.score ?? 0,
    }));
    return { items };
  }
}
