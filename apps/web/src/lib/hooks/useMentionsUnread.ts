'use client';

import { useQuery } from '@tanstack/react-query';
import { getMentionsUnreadCount } from '@/lib/messenger-api';

// ============================================================
// Mentions unread badge (Phase 5). The badge polls the LIGHT
// /mentions/unread-count endpoint (a count, not the whole feed);
// the /mentions hub page keeps its own feed query on mentionsFeedKey.
// The hub optimistically syncs mentionsUnreadCountKey on mark-read,
// so the badge drops instantly without waiting for the next poll.
// ============================================================

/** The feed cache key used by the /mentions hub page. */
export const mentionsFeedKey = ['mentions', 'feed'] as const;

/** Cache key of the light unread counter (nav badges). */
export const mentionsUnreadCountKey = ['mentions', 'unread-count'] as const;

/**
 * Unread "mentions of me" count for a nav badge. `enabled=false` skips the
 * fetch (e.g. before auth hydration). Refetches every 60s + on window focus.
 */
export function useMentionsUnread(enabled = true): number {
  const { data } = useQuery({
    queryKey: mentionsUnreadCountKey,
    queryFn: getMentionsUnreadCount,
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return data ?? 0;
}
