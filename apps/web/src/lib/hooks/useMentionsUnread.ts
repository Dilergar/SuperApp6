'use client';

import { useQuery } from '@tanstack/react-query';
import { getMentions } from '@/lib/messenger-api';

// ============================================================
// Mentions unread badge (Phase 5). Shares ONE react-query cache key
// with the /mentions hub page, so marking things read there instantly
// updates any badge using this hook (and vice-versa). Light polling
// keeps the count fresh while a nav link is mounted.
// ============================================================

/** The single feed cache key reused by the hub page + the badge. */
export const mentionsFeedKey = ['mentions', 'feed'] as const;

/**
 * Unread "mentions of me" count for a nav badge. `enabled=false` skips the
 * fetch (e.g. before auth hydration). Refetches every 60s + on window focus.
 */
export function useMentionsUnread(enabled = true): number {
  const { data } = useQuery({
    queryKey: mentionsFeedKey,
    queryFn: () => getMentions(),
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return data?.unreadCount ?? 0;
}
