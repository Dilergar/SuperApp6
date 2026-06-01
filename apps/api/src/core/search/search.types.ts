import type { SearchResultItem, SearchSourceType } from '@superapp/shared';

/** Options handed to a provider for one search run. */
export interface SearchProviderOpts {
  /** Max rows to return. */
  limit: number;
  /**
   * 'global' = a grouped overview bucket → rank by RELEVANCE, no pagination.
   * 'page'   = a flat, paginated list (in-chat / "показать ещё") → stable RECENCY keyset.
   */
  mode: 'global' | 'page';
  /** In-chat message search: scope to this chat (message provider only). */
  chatId?: string;
  /** Keyset cursor for single-type ("показать ещё") paging. */
  cursor?: string;
}

export interface SearchProviderResult {
  /** Hits, ALREADY permission-trimmed to the viewer. */
  items: SearchResultItem[];
  /** Cursor for the next page, or null/undefined if none. */
  nextCursor?: string | null;
}

/**
 * A search provider for one source type. Feature services register a provider with the
 * SearchRegistry on module init — the engine stays domain-agnostic (no core→feature import),
 * exactly like core/rich-cards. A provider MUST permission-trim its own results.
 */
export interface SearchProvider {
  type: SearchSourceType;
  /** Display label for the grouped result bucket (Чаты / Люди / Сообщения). */
  label: string;
  search(viewerId: string, query: string, opts: SearchProviderOpts): Promise<SearchProviderResult>;
  /** Optional bounded repair for the reconcile cron (e.g. re-index recent items). */
  reconcile?(): Promise<number>;
}
