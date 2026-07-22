// Messenger limits + enums — shared by API validation, web and mobile.

export const MESSENGER_LIMITS = {
  /** Max characters in a single text message. */
  maxMessageLength: 8000,
  /** Page size for the inbox (chat list). */
  chatListPageSize: 30,
  /** Page size when loading messages of a chat (scroll-back). */
  messagePageSize: 50,
  /** Group chat name length. */
  maxGroupNameLength: 80,
  /** Max members addable to a group in one request. */
  maxAddMembersAtOnce: 50,
  /** Max files in one attachment message (Telegram-альбом). */
  maxAttachmentsPerMessage: 10,
} as const;

export const CHAT_TYPES = ['dm', 'group', 'context'] as const;
export const MESSAGE_TYPES = ['text', 'system', 'rich_card', 'attachment'] as const;
// Parent kinds a CONTEXT chat attaches to (task now; event/lot/order in Phase 3).
// Note: group chats are ad-hoc (own member list), NOT attached to a Circle.
// office_room — чат встречи «Виртуального офиса» (переживает завершение звонка).
export const CHAT_PARENT_TYPES = ['task', 'calendar_event', 'listing', 'order', 'office_room'] as const;

// Chat-membership management roles (group chats).
export const CHAT_MEMBER_ROLES = ['owner', 'admin', 'member', 'bot'] as const;

// System-message event kinds (payload.eventType). Rendered as centered plaques;
// never counted as unread.
export const SYSTEM_MESSAGE_EVENTS = [
  // group lifecycle
  'group.created',
  'group.member_added',
  'group.member_removed',
  'group.member_left',
  'group.renamed',
  'group.admin_granted',
  // task lifecycle (плашки задач = проекция хроники core/chatter; eventType = typeKey записи)
  'task.assigned',
  'task.submitted',
  'task.accepted',
  'task.returned',
  'task.completed',
  'task.cancelled',
  'task.deadline_changed',
  'task.priority_changed',
  'task.reward_changed',
  'task.title_changed',
  'task.description_changed',
  'task.participant_added',
  'task.participant_removed',
  // calls (плашка только по завершении: итог «Звонок · N мин» / «Пропущенный звонок»)
  'call.ended',
  'call.missed',
] as const;
