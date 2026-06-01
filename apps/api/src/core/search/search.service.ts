import { Injectable, Logger } from '@nestjs/common';
import {
  SEARCH_LIMITS,
  type GlobalSearchResults,
  type SearchGroup,
  type SearchResultPage,
  type SearchSourceType,
} from '@superapp/shared';
import { SearchRegistry } from './search.registry';

/**
 * Orchestrates the registered providers. The engine itself runs NO SQL — providers own their
 * queries + permission-trimming. Two modes:
 *  • global() — one bucket per source type, few each (per-type cap so chats don't drown messages)
 *  • page()   — a flat, cursor-paginated list of ONE type (in-chat search, "показать ещё")
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly registry: SearchRegistry) {}

  async global(viewerId: string, query: string): Promise<GlobalSearchResults> {
    const providers = this.registry.all();
    const perType = SEARCH_LIMITS.perTypeLimit;

    const groups = await Promise.all(
      providers.map(async (p): Promise<SearchGroup> => {
        try {
          // Ask for one extra to detect "hasMore" without a second query.
          const { items } = await p.search(viewerId, query, { limit: perType + 1, mode: 'global' });
          const hasMore = items.length > perType;
          return { type: p.type, items: items.slice(0, perType), hasMore };
        } catch (e) {
          this.logger.warn(`search provider "${p.type}" failed: ${String(e)}`);
          return { type: p.type, items: [], hasMore: false };
        }
      }),
    );

    const nonEmpty = groups.filter((g) => g.items.length > 0);
    return {
      query,
      groups: nonEmpty,
      totalCount: nonEmpty.reduce((n, g) => n + g.items.length, 0),
    };
  }

  async page(
    viewerId: string,
    query: string,
    type: SearchSourceType,
    opts: { chatId?: string; cursor?: string },
  ): Promise<SearchResultPage> {
    const provider = this.registry.get(type);
    if (!provider) return { query, type, items: [], nextCursor: null };

    try {
      const { items, nextCursor } = await provider.search(viewerId, query, {
        limit: SEARCH_LIMITS.pageSize,
        mode: 'page',
        chatId: opts.chatId,
        cursor: opts.cursor,
      });
      return { query, type, items, nextCursor: nextCursor ?? null };
    } catch (e) {
      this.logger.warn(`search page "${type}" failed: ${String(e)}`);
      return { query, type, items: [], nextCursor: null };
    }
  }
}
