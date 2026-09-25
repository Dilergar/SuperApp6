import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NOTE_REF_TYPE,
  SOURCE_LOCALE,
  WORKSPACE_ROLE_RANK,
  noteSnippet,
  type SearchResultItem,
  type WorkspaceRole,
} from '@superapp/shared';
import { SearchRegistry } from '../../core/search/search.registry';
import { searchSourceUuid } from '../../core/search/search.sql';
import { SearchProjectionService } from '../../core/search/search-projection.service';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { NotesAccessService } from './notes-access.service';
import { noteUrl } from './notes-dto';

interface NoteHitRow {
  id: string;
  title: string;
  plainText: string;
  spaceId: string;
  ownerType: string;
  ownerId: string;
  body: string | null;
  updatedAt: Date;
  score: number;
}

/**
 * Поиск по заметкам — провайдер core/search (индексный: title + plainText в витрине).
 * Права режутся В SQL тем же предикатом, что и списки (пространства владельца/админа →
 * btree по space_id; свои заметки члена; гранты на заметку; гранты на папку по GIN).
 */
@Injectable()
export class NotesSearchService implements OnModuleInit {
  private readonly logger = new Logger(NotesSearchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: SearchRegistry,
    private readonly projection: SearchProjectionService,
    private readonly acl: NotesAccessService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: NOTE_REF_TYPE,
      labelKey: 'notes.breadcrumb',
      search: (viewerId, query, opts) => this.search(viewerId, query, opts),
    });
  }

  // ------------------------------------------------------------
  // Индексация (best-effort, вне транзакции сохранения)
  // ------------------------------------------------------------

  async index(note: {
    id: string;
    title: string;
    plainText: string;
    spaceId: string;
    updatedAt: Date;
    deletedAt: Date | null;
    ownerType: string;
    ownerId: string;
  }): Promise<void> {
    try {
      if (note.deletedAt) {
        await this.projection.remove(NOTE_REF_TYPE, note.id);
        return;
      }
      await this.projection.upsert({
        sourceType: NOTE_REF_TYPE,
        sourceId: note.id,
        url: noteUrl(note, note.id),
        itemCreatedAt: note.updatedAt,
        title:
          note.title ||
          note.plainText.split('\n')[0]?.slice(0, 80) ||
          this.i18n.translate('notes.untitled'),
        body: note.plainText.slice(0, 20_000),
        workspaceId: note.ownerType === 'workspace' ? note.ownerId : null,
      });
    } catch (err) {
      this.logger.warn(`Indexing note ${note.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async remove(noteId: string): Promise<void> {
    await this.projection.remove(NOTE_REF_TYPE, noteId).catch(() => undefined);
  }

  // ------------------------------------------------------------
  // Поиск
  // ------------------------------------------------------------

  private async search(viewerId: string, query: string, opts: SearchProviderOpts): Promise<SearchProviderResult> {
    if (opts.chatId) return { items: [] };
    const limit = Math.min(opts.limit, 50);

    // Пространства зрителя: своё личное + организации, где он в команде (owner/admin — целиком)
    const memberships = await this.db.userRole.findMany({
      where: { userId: viewerId, context: 'workspace', isActive: true, role: { not: 'contractor' } },
      select: { tenantId: true, role: true },
    });
    const adminWs = new Set<string>();
    const memberWs = new Set<string>();
    for (const m of memberships) {
      if (!m.tenantId) continue;
      if ((WORKSPACE_ROLE_RANK[m.role as WorkspaceRole] ?? 0) >= WORKSPACE_ROLE_RANK.admin) adminWs.add(m.tenantId);
      else memberWs.add(m.tenantId);
    }
    const spaces = await this.db.noteSpace.findMany({
      where: {
        OR: [
          { ownerType: 'user', ownerId: viewerId },
          ...(adminWs.size || memberWs.size ? [{ ownerType: 'workspace', ownerId: { in: [...adminWs, ...memberWs] } }] : []),
        ],
      },
      select: { id: true, ownerType: true, ownerId: true },
    });
    const ownerSpaceIds = spaces.filter((s) => s.ownerType === 'user' || adminWs.has(s.ownerId)).map((s) => s.id);
    const memberSpaceIds = spaces.filter((s) => s.ownerType === 'workspace' && memberWs.has(s.ownerId)).map((s) => s.id);
    const grants = await this.acl.grantsFor(viewerId);
    const visible = this.acl.visibilitySql('n', ownerSpaceIds, memberSpaceIds, viewerId, grants);

    const tsq = Prisma.sql`websearch_to_tsquery('russian', ${query})`;
    const rows = await this.db.$transaction([
      this.db.$executeRaw`SET LOCAL pg_trgm.word_similarity_threshold = 0.4`,
      this.db.$queryRaw<NoteHitRow[]>(Prisma.sql`
        SELECT n."id", n."title", n."plain_text" AS "plainText", n."space_id" AS "spaceId",
               s."owner_type" AS "ownerType", s."owner_id" AS "ownerId",
               sd."body" AS "body", n."updated_at" AS "updatedAt",
               (ts_rank(sd.search_vector, ${tsq}) * 4 + word_similarity(${query}, sd.title))::float8 AS "score"
          FROM "search_documents" sd
          JOIN "notes" n ON n."id" = ${searchSourceUuid('sd')}
          JOIN "note_spaces" s ON s."id" = n."space_id"
         WHERE sd."source_type" = ${NOTE_REF_TYPE}
           AND n."deleted_at" IS NULL
           AND ${visible}
           AND (sd.search_vector @@ ${tsq} OR ${query} <% sd.title)
         ORDER BY (ts_rank(sd.search_vector, ${tsq}) * 4 + word_similarity(${query}, sd.title)) DESC,
                  n."updated_at" DESC
         LIMIT ${limit}
      `),
    ]);
    const hits = (rows[1] as NoteHitRow[]) ?? [];
    const items: SearchResultItem[] = hits.map((h) => ({
      type: NOTE_REF_TYPE,
      id: h.id,
      title: h.title || h.plainText.split('\n')[0]?.slice(0, 80) || this.i18n.translate('notes.untitled'),
      snippet: noteSnippet(h.plainText, h.title) || this.i18n.translate('notes.noteWord'),
      url: noteUrl(h, h.id),
      chatId: null,
      messageId: null,
      avatar: null,
      createdAt: h.updatedAt ? h.updatedAt.toISOString() : null,
      score: h.score ?? 0,
    }));
    return { items };
  }
}
