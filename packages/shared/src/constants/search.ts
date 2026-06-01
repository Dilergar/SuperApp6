// Unified search (Phase 6) — shared constants.

/**
 * Source kinds the search engine can return. Phase 6 wires the messenger ones
 * (message/chat/person); task/event/wish/etc. are added later as providers register.
 */
export const SEARCH_SOURCE_TYPES = ['message', 'chat', 'person'] as const;

export const SEARCH_LIMITS = {
  /** Minimum query length before a search runs (shorter = too noisy). */
  minQueryLength: 2,
  /** Max accepted query length. */
  maxQueryLength: 100,
  /** Rows per source type in a grouped (global) search — keeps one type from drowning others. */
  perTypeLimit: 8,
  /** Page size for a single-type / in-chat search ("показать ещё"). */
  pageSize: 30,
} as const;
