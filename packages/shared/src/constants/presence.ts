// Presence + typing constants — shared by API gateway, web socket client and mobile.

export const PRESENCE = {
  /** How often a connected client pings `heartbeat` over the socket (ms). */
  HEARTBEAT_INTERVAL_MS: 25_000,
  /**
   * TTL of the `presence:<userId>` key (seconds). Must comfortably exceed the
   * heartbeat interval so a brief network blip doesn't flap the user offline.
   */
  PRESENCE_TTL_SECONDS: 60,
  /** TTL of the `presence:<userId>:lastSeen` key (seconds) — ~30 days. */
  LAST_SEEN_TTL_SECONDS: 30 * 24 * 60 * 60,
  /**
   * TTL of the cached current-event entry `presence:<userId>:ctx` (seconds).
   * Short so the contextual status reflects schedule changes quickly.
   */
  CONTEXT_TTL_SECONDS: 60,
  /** Max user ids accepted in a single GET /presence batch. */
  MAX_BATCH: 100,
} as const;
