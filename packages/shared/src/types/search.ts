import { SEARCH_SOURCE_TYPES } from '../constants/search';

export type SearchSourceType = (typeof SEARCH_SOURCE_TYPES)[number];

/** One search hit, normalized across all sources. */
export interface SearchResultItem {
  type: SearchSourceType;
  /** Domain entity id: chatId (chat), userId (person), messageId (message). */
  id: string;
  /** Primary line: chat name, person name, or the chat name a message lives in. */
  title: string;
  /** Secondary line: matched text snippet (message body), no markup. */
  snippet: string | null;
  /** Deep link to open the hit. */
  url: string;
  /** Messenger context (message hits): which chat + message to jump to. */
  chatId: string | null;
  messageId: string | null;
  /** Avatar for chat/person hits. */
  avatar: string | null;
  /** ISO timestamp of the underlying item (recency); null for entities w/o one. */
  createdAt: string | null;
  /** Relevance score (higher = better) — client ordering/debug. */
  score: number;
}

/** A grouped bucket of hits for one source type (global search). */
export interface SearchGroup {
  type: SearchSourceType;
  items: SearchResultItem[];
  /** True if more of this type exist beyond perTypeLimit (offer "показать все"). */
  hasMore: boolean;
}

/** Global search response: grouped buckets (Чаты / Люди / Сообщения). */
export interface GlobalSearchResults {
  query: string;
  groups: SearchGroup[];
  totalCount: number;
}

/** Single-type / in-chat search response: a flat, cursor-paginated list. */
export interface SearchResultPage {
  query: string;
  type: SearchSourceType | null;
  items: SearchResultItem[];
  nextCursor: string | null;
}
