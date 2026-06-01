import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';

/** A row to mirror into the search index. */
export interface SearchDoc {
  sourceType: string;
  sourceId: string;
  url: string;
  /** The entity's own timestamp — drives recency ranking. */
  itemCreatedAt: Date;
  title?: string | null;
  body?: string | null;
  chatId?: string | null;
  seq?: number | null;
  authorId?: string | null;
  workspaceId?: string | null;
}

/**
 * Generic projection into the search index (core/search). Feature services call upsert/remove
 * from their domain mutations (best-effort) so the index mirrors the source tables. The index
 * is a pure cache — it can always be rebuilt from source by the backfill script. The generated
 * FTS `tsvector` + trigram indexes are maintained by Postgres (see the migration); we only write
 * title/body + the access keys.
 */
@Injectable()
export class SearchProjectionService {
  constructor(private readonly db: DatabaseService) {}

  async upsert(doc: SearchDoc): Promise<void> {
    const data = {
      url: doc.url,
      title: doc.title ?? null,
      body: doc.body ?? null,
      chatId: doc.chatId ?? null,
      seq: doc.seq ?? null,
      authorId: doc.authorId ?? null,
      workspaceId: doc.workspaceId ?? null,
      itemCreatedAt: doc.itemCreatedAt,
    };
    await this.db.searchDocument.upsert({
      where: { sourceType_sourceId: { sourceType: doc.sourceType, sourceId: doc.sourceId } },
      create: { sourceType: doc.sourceType, sourceId: doc.sourceId, ...data },
      update: data,
    });
  }

  /** Remove a single indexed item (e.g. a deleted message). */
  async remove(sourceType: string, sourceId: string): Promise<void> {
    await this.db.searchDocument.deleteMany({ where: { sourceType, sourceId } });
  }

  /** Remove every indexed row for a chat (chat doc + all its message docs) — on chat delete. */
  async removeByChat(chatId: string): Promise<void> {
    await this.db.searchDocument.deleteMany({ where: { chatId } });
  }
}
