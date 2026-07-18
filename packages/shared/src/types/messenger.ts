import {
  CHAT_TYPES,
  MESSAGE_TYPES,
  CHAT_PARENT_TYPES,
  CHAT_MEMBER_ROLES,
  SYSTEM_MESSAGE_EVENTS,
} from '../constants/messenger';
import type { CallActiveDto } from './calls';

export type ChatType = (typeof CHAT_TYPES)[number];
export type MessageType = (typeof MESSAGE_TYPES)[number];
export type ChatParentType = (typeof CHAT_PARENT_TYPES)[number];
export type ChatMemberRole = (typeof CHAT_MEMBER_ROLES)[number];
export type SystemMessageEvent = (typeof SYSTEM_MESSAGE_EVENTS)[number];
/** Sender-visible delivery state, derived from the recipients' read cursors. */
export type MessageDeliveryStatus = 'sent' | 'delivered' | 'read';

/**
 * Готовая «вьюха» вложения, ОБОГАЩАЕМАЯ сервером при выдаче ленты (НЕ хранится в
 * payload БД): подписанные ссылки + лёгкая мета. Убирает 2 HTTP-запроса (meta+download)
 * на каждую плитку — модель Slack/Discord «ссылки приходят в теле сообщения».
 * Ссылки короткоживущие (urlExpiresAt; null = вечная публичная) — клиент при истечении
 * падает обратно на GET /files/:id/download.
 */
export interface AttachmentFileView {
  url: string;
  thumbUrl: string | null;
  posterUrl: string | null;
  /** ISO-время истечения подписи; null — вечная ссылка (публичный класс). */
  urlExpiresAt: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Волна голосового (meta.waveform, 96 бакетов 0..100). */
  waveform: number[] | null;
}

/** Одно вложение внутри attachment-сообщения (снимок метаданных файла движка). */
export interface AttachmentFileRef {
  fileId: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  size: number;
  mime?: string;
  /** Профиль загрузки (voice_message → голосовой бабл/превью 🎤); у старых сообщений отсутствует */
  profile?: string;
  /** Серверное обогащение при чтении (в БД не хранится; у старых кэшей/путей отсутствует). */
  view?: AttachmentFileView;
}

/**
 * Payload сообщения type='attachment' (Ф9 мессенджера): до 10 файлов альбомом,
 * подпись живёт в Message.content (К-1: правки/упоминания/поиск работают как у text).
 * Байты — в движке файлов; доступ наследуется через FileLink refType='chat_message'.
 */
export interface AttachmentsPayload {
  kind: 'attachments';
  files: AttachmentFileRef[];
}

/** Compact message used in chat-list previews. */
export interface MessagePreview {
  id: string;
  seq: number;
  authorId: string | null;
  authorName: string | null;
  type: MessageType;
  /** Plain-text preview (content for text; rendered summary for system/rich_card). */
  text: string | null;
  createdAt: string;
  deleted: boolean;
}

/** A chat as shown in the left-hand inbox list. */
export interface ChatSummary {
  id: string;
  type: ChatType;
  /** Resolved display title (peer full name for DM; group name; task title for context). */
  title: string;
  /** Peer avatar (DM) or null. */
  avatar: string | null;
  /** DM peer user id (null for group/context). */
  peerUserId: string | null;
  parentType: ChatParentType | null;
  parentId: string | null;
  /** Members count (group/context); null for DM. */
  memberCount: number | null;
  /** The viewer's management role in this chat (owner|admin|member|bot). */
  myRole: ChatMemberRole;
  lastMessage: MessagePreview | null;
  unreadCount: number;
  muted: boolean;
  pinned: boolean;
  updatedAt: string;
  /** Живой созвон в этом чате (refType='chat'); null/absent — звонка нет. */
  activeCall?: CallActiveDto | null;
}

/** Compact preview of a quoted message (Phase 7 reply/quote). */
export interface MessageReplyPreview {
  id: string;
  authorName: string | null;
  /** Plain-text snippet of the quoted message (null if it was deleted). */
  text: string | null;
  deleted: boolean;
}

/** A single message in the open conversation. */
export interface ChatMessage {
  id: string;
  chatId: string;
  authorId: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  type: MessageType;
  content: string | null;
  payload: Record<string, unknown> | null;
  seq: number;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  /** True if the current viewer is the author (recomputed client-side on socket payloads). */
  mine: boolean;
  /** Present on the viewer's own messages: sent | delivered | read (DM). */
  status?: MessageDeliveryStatus;
  /**
   * Author's role label relative to the VIEWER (group: my contact label for them;
   * task: their objective task role like "Исполнитель"). Null if none.
   */
  authorRoleTag?: string | null;
  /** If this message quotes another (Phase 7): a compact preview of the quoted message. */
  replyTo?: MessageReplyPreview | null;
}

export interface ChatParticipantInfo {
  userId: string;
  name: string;
  avatar: string | null;
  /** Chat membership role: owner | admin | member | bot. */
  role: ChatMemberRole;
  /** Role label relative to the viewer (my contact label, or task role). Null if none. */
  roleTag: string | null;
  deliveredSeq: number;
  lastReadSeq: number;
}

export interface ChatDetail {
  id: string;
  type: ChatType;
  title: string;
  avatar: string | null;
  peerUserId: string | null;
  parentType: ChatParentType | null;
  parentId: string | null;
  /** Group owner (createdById); null for dm/context. */
  createdById: string | null;
  /** The viewer's management role. */
  myRole: ChatMemberRole;
  participants: ChatParticipantInfo[];
  myLastReadSeq: number;
  muted: boolean;
  pinned: boolean;
  /** Живой созвон в этом чате (refType='chat'); null — звонка нет. */
  activeCall?: CallActiveDto | null;
}

/**
 * Socket `call:state` (+ GET /messenger/calls/active) — идемпотентный снимок звонка чата.
 * Один и тот же формат гасит и зажигает всё: дозвон DM (active с непустыми participants
 * без меня), баннер «Идёт звонок» в группах/контекстных, индикатор записи.
 */
export interface ChatCallStatePayload {
  chatId: string;
  chatType: ChatType;
  /** Название чата для модалки входящего (имя собеседника в DM, имя группы) */
  chatTitle: string;
  /** Имя звонящего (startedById) для модалки входящего */
  startedByName: string | null;
  active: CallActiveDto | null;
}

// ---- request payloads ----
export interface OpenDmRequest {
  userId: string;
}
export interface CreateGroupRequest {
  /** Group name (required). */
  name: string;
  /** Initial members — user ids from the creator's Окружение. */
  memberIds: string[];
}
export interface AddMembersRequest {
  userIds: string[];
}
export interface RenameChatRequest {
  title: string;
}
export interface SendMessageRequest {
  content: string;
  /** Optional id of a message in the same chat to quote (reply). */
  replyToId?: string;
}
export interface EditMessageRequest {
  content: string;
}

// ---- realtime socket events (server → client) ----
export interface WsMessageNew {
  chatId: string;
  message: ChatMessage;
}
export interface WsMessageUpdated {
  chatId: string;
  message: ChatMessage;
}
/** Read/delivery cursor advanced for a member — lets senders update ticks live. */
export interface WsReceipt {
  chatId: string;
  userId: string;
  deliveredSeq: number;
  lastReadSeq: number;
}
