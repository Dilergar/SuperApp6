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
  category: 'contacts' | 'tasks' | 'calendar' | 'system';
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
  'task.completed': {
    title: 'Задача выполнена: {{taskTitle}}',
    icon: '✅',
    pushByDefault: false,
    category: 'tasks',
  },
  'task.commented': {
    title: 'Новый комментарий: {{taskTitle}}',
    icon: '💬',
    pushByDefault: true,
    category: 'tasks',
  },
  'task.due_soon': {
    title: 'Скоро дедлайн: {{taskTitle}}',
    icon: '⏰',
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
