import { MENTION_SOURCE_TYPES } from '../constants/mention';

export type MentionSourceType = (typeof MENTION_SOURCE_TYPES)[number];

/** One row in the Mentions Hub feed (a mention OF the current user). */
export interface MentionItem {
  id: string;
  mentionerUserId: string;
  mentionerName: string;
  mentionerAvatar: string | null;
  sourceType: MentionSourceType;
  sourceId: string;
  chatId: string | null;
  messageId: string | null;
  /** Short context text. */
  snippet: string | null;
  /** Where the chat/source title (e.g. chat name) for display, if resolvable. */
  contextTitle: string | null;
  /** Deep link into the source context. */
  url: string;
  read: boolean;
  createdAt: string;
}

export interface MentionFeed {
  items: MentionItem[];
  unreadCount: number;
  nextCursor: string | null;
}

/** A candidate the @-picker can insert (a member of the current chat). */
export interface MentionCandidate {
  userId: string;
  name: string;
  avatar: string | null;
}

// ---- request payloads ----
export interface MarkMentionsReadRequest {
  /** Explicit ids, or empty/omitted = mark all read. */
  ids?: string[];
}
