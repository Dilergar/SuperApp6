// ============================================================
// Notifications — cross-module notification feed
// ============================================================
// Every module emits notifications through the central NotificationsService.
// `type` is a dot-namespaced string; `payload` is type-specific JSON.
// Clients render the notification using `title` + `body` + `actionUrl`,
// and use `type` / `payload` for richer UI (icon, click handler).

export type NotificationType =
  // Contacts / Invitations
  | 'contact.invitation.received'
  | 'contact.invitation.accepted'
  | 'contact.invitation.rejected'
  | 'contact.invitation.cancelled'
  | 'contact.linked' // generic: a new ContactLink appeared (either direction)
  | 'contact.removed'
  // Tasks
  | 'task.assigned' // you were added to a task (executor / co_executor / observer)
  | 'task.submitted' // an executor sent their part for review (→ creator)
  | 'task.accepted' // the creator accepted your work (→ executor)
  | 'task.returned' // the creator returned your work for rework (→ executor)
  | 'task.completed' // a task was fully completed
  | 'task.commented' // new message in the task chat
  | 'task.due_soon' // deadline approaching
  | 'task.overdue'
  // Calendar
  | 'calendar.event.invited'
  | 'calendar.event.reminder'
  // System
  | 'system.welcome'
  | 'system.announcement';

export interface Notification<TPayload = unknown> {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  payload: TPayload | null;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

// ============================================================
// Payload shapes per notification type
// ============================================================

export interface ContactInvitationReceivedPayload {
  invitationId: string;
  fromUserId: string;
  fromName: string;
  fromPhone: string;
  proposedRoleForRecipient: string | null;
  message: string | null;
}

export interface ContactInvitationAcceptedPayload {
  invitationId: string;
  byUserId: string;
  byName: string;
  contactLinkId: string;
}

export interface ContactInvitationRejectedPayload {
  invitationId: string;
  byUserId: string;
  byName: string;
}

export interface ContactLinkedPayload {
  contactLinkId: string;
  otherUserId: string;
  otherName: string;
}

export interface TaskNotificationPayload {
  taskId: string;
  taskTitle: string;
  /** The actor who triggered the notification (assigner, submitter, accepter…). */
  byUserId?: string;
  byName?: string;
}

// ============================================================
// Requests / feed list
// ============================================================

export interface NotificationListResponse {
  items: Notification[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface MarkNotificationsReadRequest {
  // Explicit list — or empty to mark ALL unread as read.
  notificationIds?: string[];
}
