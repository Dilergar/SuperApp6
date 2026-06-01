export type ScheduledMessageStatus = 'pending' | 'sent' | 'cancelled';

/** A pending/sent scheduled message ("Напомнить") in a chat, owned by the viewer. */
export interface ScheduledMessageItem {
  id: string;
  chatId: string;
  content: string;
  replyToId: string | null;
  /** ISO timestamp when it fires. */
  sendAt: string;
  status: ScheduledMessageStatus;
  createdAt: string;
}
