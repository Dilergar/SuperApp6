// ============================================================
// Notification type registry
// ============================================================
// Реестр называет СМЫСЛ типа: иконка, категория настроек, нужен ли push.
// СЛОВА живут в каталоге `@superapp/i18n` — `notifications.<type>.title` и
// (необязательно) `notifications.<type>.body`. Тот же приём, что `icon: '📋'`:
// shared называет вещь, каталог даёт ей имя на языке зрителя.
//
// Почему подписи здесь больше нет: строка в реестре — это ОДИН язык навсегда,
// а текст уведомления рендерится ПРИ ЧТЕНИИ в языке того, кто открыл ленту.

import type { NotificationType } from '../types/notification';

export interface NotificationMeta {
  // Icon hint for the client (emoji or icon name)
  icon: string;
  // Whether this notification type produces a push notification by default.
  pushByDefault: boolean;
  // Category bucket for notification preferences UI.
  category:
    | 'contacts'
    | 'tasks'
    | 'documents'
    | 'calendar'
    | 'workspaces'
    | 'shop'
    | 'processes'
    | 'finance'
    | 'drive'
    | 'notes'
    | 'system';
}

export const NOTIFICATION_REGISTRY: Record<NotificationType, NotificationMeta> = {
  // Contacts
  'contact.invitation.received': {
    icon: '👋',
    pushByDefault: true,
    category: 'contacts',
  },
  'contact.invitation.accepted': {
    icon: '✅',
    pushByDefault: true,
    category: 'contacts',
  },
  'contact.invitation.rejected': {
    icon: '✖️',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.invitation.cancelled': {
    icon: '↩️',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.invitation.expired': {
    icon: '⌛',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.linked': {
    icon: '🔗',
    pushByDefault: false,
    category: 'contacts',
  },
  'contact.removed': {
    icon: '🗑️',
    pushByDefault: false,
    category: 'contacts',
  },
  // Tasks
  'task.assigned': {
    icon: '📋',
    pushByDefault: true,
    category: 'tasks',
  },
  'wallet.coins.received': {
    icon: '💰',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.completed': {
    icon: '✅',
    pushByDefault: false,
    category: 'tasks',
  },
  'task.due_soon': {
    icon: '⏰',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.submitted': {
    icon: '📤',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.accepted': {
    icon: '🎉',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.returned': {
    icon: '↩️',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.overdue': {
    icon: '🔴',
    pushByDefault: true,
    category: 'tasks',
  },
  // Calendar
  'calendar.event.invited': {
    icon: '📅',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.event.reminder': {
    icon: '🔔',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.event.rsvp': {
    icon: '✉️',
    pushByDefault: false,
    category: 'calendar',
  },
  'calendar.event.updated': {
    icon: '✏️',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.event.cancelled': {
    icon: '🚫',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.resource.requested': {
    icon: '📦',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.resource.confirmed': {
    icon: '✅',
    pushByDefault: true,
    category: 'calendar',
  },
  'calendar.resource.rejected': {
    icon: '🚫',
    pushByDefault: true,
    category: 'calendar',
  },
  // Workspaces (B2B)
  'workspace.invitation.received': {
    icon: '🏢',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.invitation.accepted': {
    icon: '✅',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.invitation.rejected': {
    icon: '✖️',
    pushByDefault: false,
    category: 'workspaces',
  },
  'workspace.member.removed': {
    icon: '🚪',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.role.changed': {
    icon: '🔁',
    pushByDefault: true,
    category: 'workspaces',
  },
  'workspace.position.assigned': {
    icon: '💼',
    pushByDefault: true,
    category: 'workspaces',
  },
  'objects.shifts.published': {
    icon: '📣',
    pushByDefault: true,
    category: 'workspaces',
  },
  'objects.shift.changed': {
    icon: '🗓️',
    pushByDefault: true,
    category: 'workspaces',
  },
  'objects.shift.taken': {
    icon: '🙋',
    pushByDefault: false,
    category: 'workspaces',
  },
  'workspace.position.certified': {
    icon: '🎓',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Оргструктура: руководство отделом/объектом и замещение
  'staff.head.assigned': {
    icon: '🧭',
    pushByDefault: true,
    category: 'workspaces',
  },
  'staff.deputy.assigned': {
    icon: '🔁',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Архив организаций: предупреждения за 7 / 3 / 1 день до полного удаления.
  // Текст в единственном числе «{{daysWord}}» готовит отправитель — шаблонизатор
  // реестра склонять не умеет, а «осталось 1 дней» читается как баг.
  'workspace.archive.expiring': {
    icon: '🗑️',
    pushByDefault: true,
    category: 'workspaces',
  },
  // My Wish & Shop (orders)
  'shop.order.placed': {
    icon: '🛍️',
    pushByDefault: true,
    category: 'shop',
  },
  'shop.order.confirmed': {
    icon: '✅',
    pushByDefault: true,
    category: 'shop',
  },
  'shop.order.rejected': {
    icon: '✖️',
    pushByDefault: true,
    category: 'shop',
  },
  'shop.order.cancelled': {
    icon: '↩️',
    pushByDefault: false,
    category: 'shop',
  },
  'shop.order.funded': {
    icon: '🎯',
    pushByDefault: true,
    category: 'shop',
  },
  // Mentions
  'mention.received': {
    icon: '@',
    pushByDefault: true,
    category: 'system',
  },
  // Auth / безопасность аккаунта (движок core/verify)
  'auth.password.changed': {
    icon: '🔒',
    pushByDefault: true,
    category: 'system',
  },
  'auth.phone.changed': {
    icon: '📱',
    pushByDefault: true,
    category: 'system',
  },
  // Files engine — антивирус
  'files.scan.infected': {
    icon: '🦠',
    pushByDefault: true,
    category: 'system',
  },
  // Voice engine — Диктофон
  'voice.transcript.ready': {
    icon: '🎙️',
    pushByDefault: true,
    category: 'system',
  },
  'voice.transcript.failed': {
    icon: '🎙️',
    pushByDefault: false,
    category: 'system',
  },
  // Calls engine — звонки мессенджера
  'call.missed': {
    icon: '📞',
    pushByDefault: true,
    category: 'system',
  },
  'call.recording.ready': {
    icon: '⏺',
    pushByDefault: true,
    category: 'system',
  },
  'call.recording.failed': {
    icon: '⏺',
    pushByDefault: false,
    category: 'system',
  },
  // Виртуальный офис (B2B) — видеовстречи
  'office.meeting.invited': {
    icon: '🎥',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Processes (бизнес-процессы)
  'process.finished': {
    icon: '🏁',
    pushByDefault: true,
    category: 'processes',
  },
  'process.failed': {
    icon: '⚠️',
    pushByDefault: true,
    category: 'processes',
  },
  'process.step.notify': {
    icon: '🔔',
    pushByDefault: true,
    category: 'processes',
  },
  'process.approval.requested': {
    icon: '✅',
    pushByDefault: true,
    category: 'processes',
  },
  'process.task.queued': {
    icon: '📥',
    pushByDefault: true,
    category: 'processes',
  },
  'process.step.overdue': {
    icon: '⏰',
    pushByDefault: true,
    category: 'processes',
  },
  // Финансы
  'finance.budget.warning': {
    icon: '⚠️',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.budget.exceeded': {
    icon: '🚨',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.debt.payment_due': {
    icon: '📅',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.debt.paid': {
    icon: '✅',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.recurring.due': {
    icon: '🔁',
    pushByDefault: true,
    category: 'finance',
  },
  'finance.recurring.recorded': {
    icon: '✅',
    pushByDefault: false,
    category: 'finance',
  },
  'finance.book.shared': {
    icon: '📒',
    pushByDefault: true,
    category: 'finance',
  },
  // Drive
  'drive.shared': {
    icon: '🗂️',
    pushByDefault: true,
    category: 'drive',
  },
  // Заметки
  'note.shared': {
    icon: '📝',
    pushByDefault: true,
    category: 'notes',
  },
  // Гостевые ссылки наружу (core/share-links)
  'share.link.opened': {
    // guestSuffix — « — Асель», когда ссылка требовала подтверждение номера; иначе пусто.
    icon: '🔗',
    pushByDefault: false,
    category: 'drive',
  },
  // Предохранитель: ссылку открывают часто — дальше сегодня молчим, иначе массовая
  // рассылка превратила бы ленту уведомлений в счётчик.
  'share.link.opened.muted': {
    icon: '🔕',
    pushByDefault: false,
    category: 'drive',
  },
  // Согласования (core/approvals). Текст НЕ говорит «согласуйте»: то же уведомление
  // приходит на подпись и на ознакомление — глагол приносит сам шаг в {{actionLabel}}.
  // Документы: итог маршрута автору. Пер-шаговые решения оповещает сам движок
  // согласований — здесь только конец пути, ради которого документ и заводили.
  'document.resolved': {
    icon: '📄',
    pushByDefault: true,
    category: 'documents',
  },
  // Внешний контур (документы с контрагентами): исход у второй стороны.
  // Движковые sign.completed/declined для этих заявок подавлены — иначе автор
  // получал бы дубль без контекста документа.
  'document.counterparty_signed': {
    icon: '🖊️',
    pushByDefault: true,
    category: 'documents',
  },
  'document.counterparty_declined': {
    icon: '⛔',
    pushByDefault: true,
    category: 'documents',
  },
  // Отказ СВОЕГО подписанта — отдельный тип, а не «контрагент отказал»: у него
  // другая сторона отказа, другой виновник и другой следующий шаг (доработать и
  // отправить заново, а не ждать вторую сторону).
  'document.internal_declined': {
    icon: '⛔',
    pushByDefault: true,
    category: 'documents',
  },
  'document.external_expired': {
    icon: '⌛',
    pushByDefault: true,
    category: 'documents',
  },
  'approval.requested': {
    icon: '🖋️',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Напоминание ДО срока — только адресатам. Автор в этот момент ещё ничего не
  // ждёт: у людей есть время, и дёргать его нечем. Когда срок выйдет, придёт
  // 'approval.overdue' — и уже обоим.
  'approval.due_soon': {
    icon: '⏰',
    pushByDefault: true,
    category: 'workspaces',
  },
  'approval.overdue': {
    icon: '⏳',
    pushByDefault: true,
    category: 'workspaces',
  },
  'approval.resolved': {
    icon: '📋',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Тупик маршрута: шаг адресован отделу или должности, в которых нет ни одного
  // человека. Молча пропустить такой шаг нельзя (это согласование), поэтому он
  // остаётся ждать, а автор узнаёт об этом сразу, а не через неделю.
  'approval.unassigned': {
    icon: '⚠️',
    pushByDefault: true,
    category: 'workspaces',
  },
  // ---- core/sign: электронная подпись ----
  // Отдельные типы, а не переиспользование approval.*: подпись — юридическое
  // действие, и человек должен видеть в ленте именно «подписать», а не «решить».
  'sign.requested': {
    icon: '🖊️',
    pushByDefault: true,
    category: 'workspaces',
  },
  'sign.completed': {
    icon: '✅',
    pushByDefault: true,
    category: 'workspaces',
  },
  'sign.declined': {
    icon: '⛔',
    pushByDefault: true,
    category: 'workspaces',
  },
  // КЭДО (modules/hr)
  'hr.action.applied': {
    icon: '✅',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.action.failed': {
    icon: '⚠️',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.action.withdrawn': {
    icon: '↩️',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.esutd.due_soon': {
    icon: '⏰',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.campaign.assigned': {
    icon: '📄',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.campaign.reminder': {
    icon: '🔔',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.campaign.done': {
    icon: '🏁',
    pushByDefault: false,
    category: 'workspaces',
  },
  'hr.delivery.due': {
    icon: '📬',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.probation.ending': {
    icon: '⏳',
    pushByDefault: true,
    category: 'workspaces',
  },
  'hr.contract.expiring': {
    icon: '📆',
    pushByDefault: true,
    category: 'workspaces',
  },
  // Messenger — scheduled ("Напомнить")
  'messenger.scheduled.sent': {
    icon: '⏰',
    pushByDefault: true,
    category: 'system',
  },
  // System
  'system.welcome': {
    icon: '🎉',
    pushByDefault: false,
    category: 'system',
  },
  'system.announcement': {
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
