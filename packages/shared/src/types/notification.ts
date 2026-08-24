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
  | 'contact.invitation.expired' // TTL ran out — told to the SENDER, who else would never know
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
  | 'workspace.archive.expiring' // your archived org is about to be deleted for good (→ owner)
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
  // Auth / безопасность аккаунта (движок core/verify)
  | 'auth.password.changed' // пароль изменён (сброс по SMS или смена из профиля)
  | 'auth.phone.changed' // номер телефона аккаунта изменён
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
  // Drive (OmniDrive)
  | 'drive.shared' // вам открыли доступ к папке или файлу на Диске
  | 'document.resolved' // маршрут вашего документа завершён (подписан/отклонён/на доработку)
  | 'document.counterparty_signed' // внешний контур: контрагент подписал документ
  | 'document.counterparty_declined' // внешний контур: контрагент отказался подписывать
  | 'document.internal_declined' // внешний контур: отказался НАШ подписант — документ не ушёл к контрагенту
  | 'document.external_expired' // внешний контур: срок подписания истёк, документ вернулся в черновик
  | 'share.link.opened' // вашу гостевую ссылку наружу открыли
  | 'share.link.opened.muted' // открывают часто — уведомления по ней замолкают до завтра
  // Согласования (core/approvals) — «Ждут решения»
  | 'approval.requested' // от вас ждут решения: согласовать, подписать или ознакомиться
  | 'approval.due_soon' // срок подходит — напоминание тем, кто ещё не ответил
  | 'approval.overdue' // срок решения вышел, а решения нет
  | 'approval.resolved' // по вашей заявке принято решение
  | 'approval.unassigned' // решать некому: в отделе или на должности нет ни одного человека
  // Электронная подпись (core/sign). Отдельные типы, а не approval.*: подпись —
  // юридическое действие, и в ленте человек должен видеть «подпишите», а не
  // «решите» (от этого зависит, с каким ключом он сядет за компьютер).
  | 'sign.requested' // документ ждёт вашей подписи
  | 'sign.completed' // документ подписан всеми
  | 'sign.declined' // подписант отказался, документ не подписан
  // КЭДО (modules/hr)
  | 'hr.action.applied' // кадровое действие применено (кадровику и сотруднику)
  | 'hr.action.failed' // действие не применилось (проверка законности/данные)
  | 'hr.action.withdrawn' // работник отозвал заявление (ст. 56 п. 4) — кадровику
  | 'hr.esutd.due_soon' // подходит срок сдачи в ЕСУТД
  | 'hr.campaign.assigned' // вам направлен документ на ознакомление
  | 'hr.campaign.reminder' // напоминание: документ ждёт ознакомления
  | 'hr.campaign.done' // кампания ознакомления завершена (автору)
  | 'hr.delivery.due' // акт ждёт вручения (3 рабочих дня, ст. 61 п. 3)
  | 'hr.probation.ending' // испытательный срок сотрудника заканчивается
  | 'hr.contract.expiring' // срочный договор заканчивается (уведомить в последний день!)
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
// ЗАГОТОВКА — осознанно без потребителей. Сегодня карта `notifications.map.ts`
// объявляет `payload: Record<string, unknown>`, а центра уведомлений в вебе нет
// вовсе. Эти формы описывают богатый рендер (иконка, обработчик клика) и
// подключаются вместе с центром уведомлений и mobile-push (блок 8 дорожной карты).
// Не удалять «как мёртвые»: это не рукопись мимо реализации, а согласованный
// список того, что фактически кладут эмиттеры.

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

// Тело `POST /notifications/mark-read` описано Zod-схемой
// (`markNotificationsReadSchema` → `MarkNotificationsReadInput`) — рукописного
// интерфейса здесь нет по общему правилу «вход = z.infer».
