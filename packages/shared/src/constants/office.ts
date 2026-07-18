// ============================================
// Виртуальный офис (B2B) — константы
// ============================================

/** meeting — встреча-конференция (v1); channel — постоянная комната (Discord-фаза 2) */
export const OFFICE_ROOM_KINDS = ['meeting', 'channel'] as const;
export const OFFICE_ROOM_STATUSES = ['active', 'ended'] as const;
export const OFFICE_ROOM_ROLES = ['host', 'participant'] as const;

export const OFFICE_ROOM_ROLE_LABELS: Record<(typeof OFFICE_ROOM_ROLES)[number], string> = {
  host: 'Организатор',
  participant: 'Участник',
};

export const OFFICE_LIMITS = {
  maxNameLen: 120,
  /** Людей в одном приглашении */
  maxInviteBatch: 50,
  /** Крон авто-завершает встречу без созвона дольше N часов (ссылка Meet живёт часы, не дни) */
  autoEndIdleHours: 4,
  /** Поллинг списка встреч на вебе (live-присутствие через шину→socket — Discord-фаза 2) */
  listPollMs: 7000,
  /** Страница «Истории» завершённых встреч (cursor-пагинация) */
  historyPageSize: 20,
} as const;
