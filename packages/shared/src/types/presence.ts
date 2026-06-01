// Presence + typing types — shared by API, web and mobile.

/**
 * Contextual status derived from the target's CURRENT calendar event, tailored to
 * the viewer's calendar access level:
 *   - detailed → label shows the event title ("На <title> до HH:MM")
 *   - busy     → only "Занят до HH:MM"
 *   - none     → no contextual status (null PresenceInfo.contextual)
 */
export type ContextualStatus = {
  label: string;
  level: 'busy' | 'detailed';
} | null;

/** Per-viewer presence view of one target user. */
export interface PresenceInfo {
  userId: string;
  /** True iff the target has a live connection AND is visible to this viewer (privacy). */
  online: boolean;
  /** ISO timestamp of the target's last disconnect, or null (hidden / never seen). */
  lastSeen: string | null;
  /** Contextual "in a meeting" status, or null. */
  contextual: ContextualStatus;
}

/** Response of the batch presence endpoint (GET /messenger/presence). */
export interface PresenceQueryResult {
  items: PresenceInfo[];
}

// ------------------------------------------------------------
// Socket event payloads
// ------------------------------------------------------------

/**
 * Server→client lightweight ping: this user's presence/contextual may have changed —
 * interested clients should refetch via GET /messenger/presence.
 */
export interface WsPresenceChanged {
  userId: string;
}

/** Server→client typing relay (and the shape echoed from typing:start/stop). */
export interface WsTyping {
  chatId: string;
  userId: string;
  typing: boolean;
}
