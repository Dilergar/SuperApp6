import { apiDelete, apiGet, apiPatch, apiPost } from './api';
import type {
  ChatSummary,
  ChatMessage,
  ChatDetail,
  RichCardRefType,
  ExecuteRichCardActionResult,
  RichCardPayload,
  PresenceInfo,
  MentionCandidate,
  MentionFeed,
  GlobalSearchResults,
  SearchResultPage,
  QuickActionDescriptor,
  QuickActionScope,
  ScheduledMessageItem,
  PresenceQueryResult,
} from '@superapp/shared';
import { PRESENCE } from '@superapp/shared';

// Конверт `{ success, data }` распаковывают хелперы транспорта (`@/lib/api`) —
// здесь остаются только домен и его типы из @superapp/shared.

/** Inbox — already sorted pinned-first then recent by the server. */
export async function listChats(): Promise<ChatSummary[]> {
  return apiGet<ChatSummary[]>('/messenger/chats');
}

/** Get-or-create a direct-message chat with another user. */
export async function openDm(userId: string): Promise<ChatDetail> {
  return apiPost<ChatDetail>('/messenger/chats/dm', { userId });
}

/** Create an ad-hoc group chat (name + initial members from Окружение). */
export async function createGroup(name: string, memberIds: string[]): Promise<ChatDetail> {
  return apiPost<ChatDetail>('/messenger/chats/group', { name, memberIds });
}

/** Rename a group chat (owner/admin). */
export async function renameChat(chatId: string, title: string): Promise<ChatDetail> {
  return apiPatch<ChatDetail>(`/messenger/chats/${chatId}`, { title });
}

/** Add members to a group chat (owner/admin). */
export async function addMembers(chatId: string, userIds: string[]): Promise<ChatDetail> {
  return apiPost<ChatDetail>(`/messenger/chats/${chatId}/members`, { userIds });
}

/** Remove a member from a group chat (owner/admin; passing my own id = leave). */
export async function removeMember(chatId: string, userId: string): Promise<void> {
  await apiDelete(`/messenger/chats/${chatId}/members/${userId}`);
}

/** Leave a group chat (everyone except the owner). */
export async function leaveChat(chatId: string): Promise<void> {
  await apiPost(`/messenger/chats/${chatId}/leave`, {});
}

/** Grant or revoke admin on a member (owner only). */
export async function setAdmin(chatId: string, userId: string, admin: boolean): Promise<ChatDetail> {
  return apiPost<ChatDetail>(`/messenger/chats/${chatId}/admins/${userId}`, { admin });
}

/** Delete a group chat entirely (owner only). */
export async function deleteChat(chatId: string): Promise<void> {
  await apiDelete(`/messenger/chats/${chatId}`);
}

/** Get-or-create the context chat attached to a task. */
export async function getTaskChat(taskId: string): Promise<ChatDetail> {
  return apiGet<ChatDetail>(`/messenger/tasks/${taskId}/chat`);
}

export async function getChat(chatId: string): Promise<ChatDetail> {
  return apiGet<ChatDetail>(`/messenger/chats/${chatId}`);
}

/**
 * Messages of a chat, ascending by seq.
 * Omit `before` for the latest page; pass the smallest loaded seq for older.
 */
export async function getMessages(
  chatId: string,
  before?: number,
): Promise<ChatMessage[]> {
  return apiGet<ChatMessage[]>(`/messenger/chats/${chatId}/messages`, {
    params: before != null ? { before } : undefined,
  });
}

/**
 * Send a text message — returns the persisted message (mine=true, status 'sent').
 * Pass `replyToId` to quote another message in the same chat (Phase 7 reply).
 */
export async function sendMessage(
  chatId: string,
  content: string,
  replyToId?: string,
): Promise<ChatMessage> {
  return apiPost<ChatMessage>(`/messenger/chats/${chatId}/messages`, {
    content,
    ...(replyToId ? { replyToId } : {}),
  });
}

/** Ф9: альбом до 10 файлов движка + подпись (файлы уже загружены через files-api) */
export async function sendAttachmentMessage(
  chatId: string,
  fileIds: string[],
  caption?: string,
  replyToId?: string,
): Promise<ChatMessage> {
  return apiPost<ChatMessage>(`/messenger/chats/${chatId}/messages/attachments`, {
    fileIds,
    ...(caption ? { caption } : {}),
    ...(replyToId ? { replyToId } : {}),
  });
}

export async function editMessage(messageId: string, content: string): Promise<ChatMessage> {
  return apiPatch<ChatMessage>(`/messenger/messages/${messageId}`, { content });
}

export async function deleteMessage(messageId: string): Promise<void> {
  await apiDelete(`/messenger/messages/${messageId}`);
}

/** Advance my read cursor to `seq`. */
export async function markRead(chatId: string, seq: number): Promise<void> {
  await apiPost(`/messenger/chats/${chatId}/read`, { seq });
}

// ============================================================
// Rich Cards (Phase 3) — interactive cards posted into chats.
// A card = data + buttons. A button POSTs an action key to ONE
// endpoint; the server re-checks permissions and returns the
// UPDATED card for the actor.
// ============================================================

/**
 * Run a rich-card button. The server re-checks permissions and returns the
 * freshly re-rendered card for the actor (patch it into the message in place).
 */
export async function executeRichCardAction(
  actionKey: string,
  ref: { type: RichCardRefType; id: string },
  payload?: Record<string, unknown>,
): Promise<ExecuteRichCardActionResult> {
  return apiPost<ExecuteRichCardActionResult>(`/rich-cards/${actionKey}/execute`, { ref, payload });
}

/** Post an entity's live card into a chat (returns the posted card). */
export async function shareRichCard(
  chatId: string,
  refType: RichCardRefType,
  refId: string,
): Promise<RichCardPayload> {
  return apiPost<RichCardPayload>('/rich-cards/share', { chatId, refType, refId });
}

/** Get-or-create the context chat attached to an order/campaign. */
export async function getOrderChat(orderId: string): Promise<ChatDetail> {
  return apiGet<ChatDetail>(`/messenger/orders/${orderId}/chat`);
}

/** Get-or-create the context chat attached to a calendar event. */
export async function getEventChat(eventId: string): Promise<ChatDetail> {
  return apiGet<ChatDetail>(`/messenger/events/${eventId}/chat`);
}

/** Get-or-create the context chat attached to an office meeting (Виртуальный офис). */
export async function getOfficeRoomChat(roomId: string): Promise<ChatDetail> {
  return apiGet<ChatDetail>(`/messenger/office-rooms/${roomId}/chat`);
}

// ============================================================
// Presence (Phase 4) — per-viewer presence for a batch of user ids.
// The server already applies privacy + the viewer's calendar access
// level, so the returned PresenceInfo is safe to render verbatim.
// ============================================================

/**
 * Batch presence for the given user ids (online flag, lastSeen, contextual
 * calendar status). Returns [] without a network call when `userIds` is empty;
 * caps the request at PRESENCE.MAX_BATCH ids.
 */
export async function getPresence(userIds: string[]): Promise<PresenceInfo[]> {
  if (userIds.length === 0) return [];
  const capped = userIds.slice(0, PRESENCE.MAX_BATCH);
  const page = await apiGet<PresenceQueryResult>('/messenger/presence', {
    params: { userIds: capped.join(',') },
  });
  return page.items;
}

// ============================================================
// Mentions Hub (Phase 5) — @-mention autocomplete candidates + the
// "mentions of me" feed. Mentions are picked from chat members (users
// have no @handle) and stored inline as the `@[Имя](userId)` token.
// ============================================================

/**
 * Chat members matching the typed query (excludes self), to drive the
 * @-autocomplete popover in the composer. Empty `q` returns all members.
 */
export async function getMentionable(chatId: string, q: string): Promise<MentionCandidate[]> {
  return apiGet<MentionCandidate[]>(`/messenger/chats/${chatId}/mentionable`, {
    params: q ? { q } : undefined,
  });
}

/** Cursor-paginated feed of "mentions of me" (+ the unread count). */
export async function getMentions(cursor?: string): Promise<MentionFeed> {
  return apiGet<MentionFeed>('/mentions', {
    params: cursor ? { cursor } : undefined,
  });
}

/** Лёгкий счётчик непрочитанного для нав-бейджа — не тянет всю ленту упоминаний. */
export async function getMentionsUnreadCount(): Promise<number> {
  const res = await apiGet<{ unreadCount: number }>('/mentions/unread-count');
  return res.unreadCount;
}

/** Mark specific mentions read, or all of them when `ids` is omitted. */
export async function markMentionsRead(ids?: string[]): Promise<void> {
  await apiPost('/mentions/mark-read', ids && ids.length ? { ids } : {});
}

// ============================================================
// Search (Phase 6) — one endpoint, two modes:
//  • q only          → global grouped results (Чаты / Люди / Сообщения)
//  • q + chatId       → in-chat message page (flat, cursor-paginated)
// The server picks the mode from the params.
// ============================================================

/** Global grouped search across chats, people and messages. */
export async function searchGlobal(q: string): Promise<GlobalSearchResults> {
  return apiGet<GlobalSearchResults>('/search', { params: { q } });
}

/** In-chat message search — a flat, cursor-paginated page of message hits. */
export async function searchInChat(
  chatId: string,
  q: string,
  cursor?: string,
): Promise<SearchResultPage> {
  return apiGet<SearchResultPage>('/search', {
    params: { q, chatId, ...(cursor ? { cursor } : {}) },
  });
}

// ============================================================
// Quick Actions & Scheduled Messages (Phase 7).
// The ＋-menu (composer) and the message corner-menu are DATA-DRIVEN:
// the server returns QuickActionDescriptor[] and the web maps `key` to a
// modal. Scheduled messages ("Напомнить") fire later via the server cron.
// ============================================================

/**
 * Available quick actions for a chat, by scope:
 *  • 'composer' → the ＋-menu next to the paperclip
 *  • 'message'  → a message's corner menu
 * The web maps each descriptor's `key` to a modal (unknown keys are skipped).
 */
export async function getQuickActions(
  chatId: string,
  scope: QuickActionScope,
): Promise<QuickActionDescriptor[]> {
  return apiGet<QuickActionDescriptor[]>('/quick-actions', { params: { chatId, scope } });
}

/** The viewer's pending/sent scheduled messages in a chat. */
export async function listScheduled(chatId: string): Promise<ScheduledMessageItem[]> {
  return apiGet<ScheduledMessageItem[]>(`/messenger/chats/${chatId}/scheduled`);
}

/** Schedule a message to fire later (sendAt ISO; optional quoted message). */
export async function scheduleMessage(
  chatId: string,
  body: { content: string; sendAt: string; replyToId?: string },
): Promise<ScheduledMessageItem> {
  return apiPost<ScheduledMessageItem>(`/messenger/chats/${chatId}/scheduled`, body);
}

/** Edit a pending scheduled message's content and/or fire time. */
export async function updateScheduled(
  schedId: string,
  patch: { content?: string; sendAt?: string },
): Promise<ScheduledMessageItem> {
  return apiPatch<ScheduledMessageItem>(`/messenger/scheduled/${schedId}`, patch);
}

/** Cancel a pending scheduled message. */
export async function cancelScheduled(schedId: string): Promise<void> {
  await apiDelete(`/messenger/scheduled/${schedId}`);
}
