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
  | 'task.due_soon' // deadline approaching
  | 'task.overdue'
  // Calendar
  | 'calendar.event.invited'
  | 'calendar.event.reminder'
  | 'calendar.event.rsvp' // a participant answered (→ organizer)
  | 'calendar.event.updated' // organizer changed time/details (→ participants)
  | 'calendar.event.cancelled' // organizer deleted the event (→ participants)
  | 'calendar.resource.requested' // someone requested your resource (→ owner)
  | 'calendar.resource.confirmed' // owner confirmed your booking (→ booker)
  | 'calendar.resource.rejected' // owner rejected your booking (→ booker)
  // Workspaces (B2B)
  | 'workspace.invitation.received' // you were invited to join an organization (→ invitee)
  | 'workspace.invitation.accepted' // an invitee accepted (→ inviter / admins)
  | 'workspace.invitation.rejected' // an invitee declined (→ inviter)
  | 'workspace.member.removed' // you were removed from an organization (→ member)
  | 'workspace.role.changed' // your role in an organization changed (→ member)
  | 'workspace.position.assigned' // a position was assigned to you (→ member)
  | 'workspace.position.certified' // your position training was certified (→ member)
  // Wallet
  | 'wallet.coins.received' // you were paid coins for a completed task (→ executor)
  // My Wish & Shop (orders)
  | 'shop.order.placed' // a buyer placed an order on your shop (→ seller / co-managers)
  | 'shop.order.confirmed' // the seller confirmed the order (→ buyer)
  | 'shop.order.rejected' // the seller rejected the order (→ buyer)
  | 'shop.order.cancelled' // the buyer cancelled their order (→ seller)
  | 'shop.order.funded' // a crowdfunding campaign reached its goal (→ seller / co-managers)
  // Mentions
  | 'mention.received' // someone @mentioned you (messenger / task / event …)
  // Files engine — антивирус
  | 'files.scan.infected' // загруженный вами файл заражён и заблокирован
  // Voice engine — Диктофон
  | 'voice.transcript.ready' // расшифровка записи готова (→ владелец записи)
  | 'voice.transcript.failed' // расшифровка не удалась (→ владелец записи)
  // Calls engine — звонки мессенджера
  | 'call.missed' // пропущенный DM-звонок (→ не подключившийся собеседник)
  | 'call.recording.ready' // запись звонка в «Журнале звонков» (→ каждый клеймант)
  | 'call.recording.failed' // запись звонка не удалась (→ включивший запись)
  // Виртуальный офис (B2B) — видеовстречи
  | 'office.meeting.invited' // вас пригласили на встречу (→ приглашённый)
  // Processes (бизнес-процессы)
  | 'process.finished' // запущенный вами процесс дошёл до конца (→ инициатор)
  | 'process.failed' // процесс остановился с ошибкой (→ инициатор)
  | 'process.step.notify' // нода «Уведомить» внутри процесса (произвольный текст)
  | 'process.approval.requested' // нужно ваше решение по одобрению (→ согласующий)
  | 'process.task.queued' // новая задача вашего отдела ждёт в очереди (→ члены отдела)
  | 'process.step.overdue' // шаг процесса просрочен по SLA (→ инициатор)
  // Messenger — scheduled ("Напомнить")
  | 'messenger.scheduled.sent' // your scheduled message was delivered to the chat (→ you)
  // Финансы
  | 'finance.budget.warning' // лимит категории почти исчерпан (пересекли 80%)
  | 'finance.budget.exceeded' // лимит категории превышен (пересекли 100%)
  | 'finance.debt.payment_due' // сегодня платёж по долгу (напоминание + «Оплачено» в 1 тап)
  | 'finance.debt.paid' // долг полностью выплачен 🎉
  | 'finance.recurring.due' // повторяющаяся операция ждёт подтверждения (autoRecord=false)
  | 'finance.recurring.recorded' // повторяющаяся операция записана автоматически
  | 'finance.book.shared' // вам открыли доступ к финансовой книге
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

export interface WorkspaceInvitationReceivedPayload {
  invitationId: string;
  workspaceId: string;
  workspaceName: string;
  invitedByName: string;
  role: string;
  position: string | null;
  message: string | null;
}

export interface WorkspaceNotificationPayload {
  workspaceId: string;
  workspaceName: string;
  /** Present for accepted/rejected (the invitee's name) and role.changed (the new role). */
  byName?: string;
  role?: string;
}

export interface WalletCoinsReceivedPayload {
  amount: number;
  currencyName: string;
  taskId?: string;
  taskTitle?: string;
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
