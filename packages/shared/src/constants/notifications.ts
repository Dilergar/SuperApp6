// ============================================================
// Notification type registry
// ============================================================
// Central place where each notification type is described.
// Services that emit notifications look up the meta here
// to get a default title/body template and icon hint.

import type { NotificationType } from '../types/notification';

export interface NotificationMeta {
  // Human-readable title template (may reference payload via {{placeholder}})
  title: string;
  // Optional body template
  body?: string;
  // Icon hint for the client (emoji or icon name)
  icon: string;
  // Whether this notification type produces a push notification by default.
  pushByDefault: boolean;
  // Category bucket for notification preferences UI.
  category: 'contacts' | 'tasks' | 'calendar' | 'workspaces' | 'shop' | 'processes' | 'finance' | 'system';
}

export const NOTIFICATION_REGISTRY: Record<NotificationType, NotificationMeta> = {
  // Contacts
  'contact.invitation.received': {
    title: '{{fromName}} хочет добавить вас в контакты',
    body: '{{message}}',
    icon: '👋',
    pushByDefault: true,
    category: 'contacts',
  },
  'contact.invitation.accepted': {
    title: '{{byName}} принял ваше приглашение',
    icon: '✅',
    pushByDefault: true,
    category: 'contacts',
  },
  'contact.invitation.rejected': {
    title: '{{byName}} отклонил ваше приглашение',
    icon: '✖️',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.invitation.cancelled': {
    title: 'Приглашение отменено',
    icon: '↩️',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.linked': {
    title: '{{otherName}} теперь в ваших контактах',
    icon: '🔗',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.removed': {
    title: 'Контакт удалён',
    icon: '🗑️',
    pushByDefault: false,
    category: 'contacts',
  },
  // Tasks
  'task.assigned': {
    title: 'Вам назначена задача: {{taskTitle}}',
    icon: '📋',
    pushByDefault: true,
    category: 'tasks',
  },
  'wallet.coins.received': {
    title: 'Вы заработали {{amount}} {{currencyName}}',
    body: 'За задачу «{{taskTitle}}»',
    icon: '💰',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.completed': {
    title: 'Задача выполнена: {{taskTitle}}',
    icon: '✅',
    pushByDefault: false,
    category: 'tasks',
  },
  'task.due_soon': {
    title: 'Скоро дедлайн: {{taskTitle}}',
    icon: '⏰',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.submitted': {
    title: '{{byName}} сдал(а) задачу на проверку: {{taskTitle}}',
    icon: '📤',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.accepted': {
    title: 'Задача принята: {{taskTitle}}',
    icon: '🎉',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.returned': {
    title: 'Задача возвращена в работу: {{taskTitle}}',
    icon: '↩️',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.overdue': {
    title: 'Просрочена задача: {{taskTitle}}',
    icon: '🔴',
    pushByDefault: true,
    category: 'tasks',
  },
  // Calendar
  'calendar.event.invited': {
    title: 'Приглашение на событие: {{eventTitle}}',
    icon: '📅',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.event.reminder': {
    title: 'Напоминание: {{eventTitle}}',
    icon: '🔔',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.event.rsvp': {
    title: '{{byName}}: {{rsvpLabel}} — {{eventTitle}}',
    icon: '✉️',
    pushByDefault: false,
    category: 'calendar',
  },
  'calendar.event.updated': {
    title: 'Событие изменено: {{eventTitle}}',
    icon: '✏️',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.event.cancelled': {
    title: 'Событие отменено: {{eventTitle}}',
    icon: '🚫',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.resource.requested': {
    title: 'Заявка на «{{resourceName}}»: {{eventTitle}}',
    icon: '📦',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.resource.confirmed': {
    title: 'Бронь подтверждена: {{resourceName}}',
    icon: '✅',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.resource.rejected': {
    title: 'Бронь отклонена: {{resourceName}}',
    icon: '🚫',
    pushByDefault: true,
    category: 'calendar',
  },
  // Workspaces (B2B)
  'workspace.invitation.received': {
    title: '{{workspaceName}} приглашает вас на работу',
    body: '{{message}}',
    icon: '🏢',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.invitation.accepted': {
    title: '{{byName}} принял(а) приглашение в {{workspaceName}}',
    icon: '✅',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.invitation.rejected': {
    title: '{{byName}} отклонил(а) приглашение в {{workspaceName}}',
    icon: '✖️',
    pushByDefault: false,
    category: 'workspaces',
  },
  'workspace.member.removed': {
    title: 'Вас исключили из организации {{workspaceName}}',
    icon: '🚪',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.role.changed': {
    title: 'Ваша роль в {{workspaceName}} изменена: {{role}}',
    icon: '🔁',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.position.assigned': {
    title: 'Вам назначена должность в {{workspaceName}}: {{positionName}}',
    body: '{{branchName}}',
    icon: '💼',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.position.certified': {
    title: 'Вы аттестованы по должности {{positionName}} в {{workspaceName}}',
    icon: '🎓',
    pushByDefault: true,
    category: 'workspaces',
  },
  // My Wish & Shop (orders)
  'shop.order.placed': {
    title: 'Новый заказ: {{title}}',
    icon: '🛍️',
    pushByDefault: true,
    category: 'shop',
  },
  'shop.order.confirmed': {
    title: 'Заказ подтверждён: {{title}}',
    icon: '✅',
    pushByDefault: true,
    category: 'shop',
  },
  'shop.order.rejected': {
    title: 'Заказ отклонён: {{title}}',
    icon: '✖️',
    pushByDefault: true,
    category: 'shop',
  },
  'shop.order.cancelled': {
    title: 'Покупатель отменил заказ: {{title}}',
    icon: '↩️',
    pushByDefault: false,
    category: 'shop',
  },
  'shop.order.funded': {
    title: 'Сбор собран: {{title}} — подтвердите',
    icon: '🎯',
    pushByDefault: true,
    category: 'shop',
  },
  // Mentions
  'mention.received': {
    title: '{{mentionerName}} упомянул(а) вас',
    body: '{{snippet}}',
    icon: '@',
    pushByDefault: true,
    category: 'system',
  },
  // Files engine — антивирус
  'files.scan.infected': {
    title: 'Файл «{{name}}» заражён и заблокирован',
    icon: '🦠',
    pushByDefault: true,
    category: 'system',
  },
  // Voice engine — Диктофон
  'voice.transcript.ready': {
    title: 'Расшифровка «{{title}}» готова',
    icon: '🎙️',
    pushByDefault: true,
    category: 'system',
  },
  'voice.transcript.failed': {
    title: 'Не удалось расшифровать «{{title}}»',
    icon: '🎙️',
    pushByDefault: false,
    category: 'system',
  },
  // Calls engine — звонки мессенджера
  'call.missed': {
    title: 'Пропущенный звонок от {{fromName}}',
    icon: '📞',
    pushByDefault: true,
    category: 'system',
  },
  'call.recording.ready': {
    title: 'Запись звонка «{{title}}» — в Журнале звонков',
    icon: '⏺',
    pushByDefault: true,
    category: 'system',
  },
  'call.recording.failed': {
    title: 'Не удалось записать звонок',
    icon: '⏺',
    pushByDefault: false,
    category: 'system',
  },
  // Виртуальный офис (B2B) — видеовстречи
  'office.meeting.invited': {
    title: '{{byName}} приглашает вас на встречу «{{roomName}}»',
    icon: '🎥',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Processes (бизнес-процессы)
  'process.finished': {
    title: 'Процесс «{{processName}}» завершён',
    icon: '🏁',
    pushByDefault: true,
    category: 'processes',
  },
  'process.failed': {
    title: 'Процесс «{{processName}}» остановлен с ошибкой',
    body: '{{error}}',
    icon: '⚠️',
    pushByDefault: true,
    category: 'processes',
  },
  'process.step.notify': {
    title: '{{title}}',
    body: '{{message}}',
    icon: '🔔',
    pushByDefault: true,
    category: 'processes',
  },
  'process.approval.requested': {
    title: 'Нужно ваше решение: {{title}}',
    body: 'Процесс «{{processName}}»',
    icon: '✅',
    pushByDefault: true,
    category: 'processes',
  },
  'process.task.queued': {
    title: 'Новая задача отдела: {{title}}',
    body: '{{departmentName}} · процесс «{{processName}}»',
    icon: '📥',
    pushByDefault: true,
    category: 'processes',
  },
  'process.step.overdue': {
    title: 'Просрочен шаг: {{title}}',
    body: 'Процесс «{{processName}}»',
    icon: '⏰',
    pushByDefault: true,
    category: 'processes',
  },
  // Финансы
  'finance.budget.warning': {
    title: 'Лимит «{{categoryName}}» почти исчерпан',
    body: '{{spent}} из {{limit}} за {{periodLabel}}',
    icon: '⚠️',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.budget.exceeded': {
    title: 'Лимит «{{categoryName}}» превышен',
    body: '{{spent}} из {{limit}} за {{periodLabel}}',
    icon: '🚨',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.debt.payment_due': {
    title: 'Сегодня платёж по «{{debtName}}»',
    body: '{{amount}} — подтвердите оплату в Финансах',
    icon: '📅',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.debt.paid': {
    title: 'Долг «{{debtName}}» полностью выплачен 🎉',
    body: '{{amount}}',
    icon: '✅',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.recurring.due': {
    title: 'Подтвердите операцию «{{title}}»',
    body: '{{amount}}',
    icon: '🔁',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.recurring.recorded': {
    title: 'Записано: {{title}}',
    body: '{{amount}}',
    icon: '✅',
    pushByDefault: false,
    category: 'finance',
  },
  'finance.book.shared': {
    title: '{{ownerName}} открыл(а) вам доступ к финансам',
    body: 'Роль: {{roleLabel}}',
    icon: '📒',
    pushByDefault: true,
    category: 'finance',
  },
  // Messenger — scheduled ("Напомнить")
  'messenger.scheduled.sent': {
    title: 'Напоминание отправлено',
    body: '{{snippet}}',
    icon: '⏰',
    pushByDefault: true,
    category: 'system',
  },
  // System
  'system.welcome': {
    title: 'Добро пожаловать в SuperApp6!',
    icon: '🎉',
    pushByDefault: false,
    category: 'system',
  },
  'system.announcement': {
    title: '{{title}}',
    icon: '📢',
    pushByDefault: false,
    category: 'system',
  },
};

// ============================================================
// Event-name <-> notification-type mapping helper
// ============================================================
// Modules publish events on EventBus (e.g. "contact.invitation.sent").
// The NotificationsService subscribes and maps event → notification type.
// Keep this mapping here so all three layers agree.

export const NOTIFICATION_LIMITS = {
  // Max items returned per feed page
  pageSize: 30,
  // How long notifications are retained (days). Older rows are pruned by a background job.
  retentionDays: 90,
} as const;
