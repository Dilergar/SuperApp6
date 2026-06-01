// Quick Actions & Scheduled Messages (Phase 7) — shared constants.

/** Where a quick action appears: the composer ＋-menu, a message's corner menu, or both. */
export const QUICK_ACTION_SCOPES = ['composer', 'message'] as const;

export const SCHEDULED_MESSAGE_LIMITS = {
  /** Minimum lead time before a scheduled message may fire (seconds). */
  minLeadSeconds: 30,
  /** Maximum scheduling horizon (days). */
  maxHorizonDays: 365,
  /** Max pending scheduled messages one user may hold in a chat. */
  maxPendingPerChat: 50,
} as const;
