import { defineNotifications } from './types';

/**
 * Согласования (core/approvals) — «Ждут решения». Уведомление лишь объявляет и ведёт
 * в стопку; сама очередь обязательств живёт в движке согласований.
 * Текст НЕ говорит «согласуйте»: глагол приносит шаг в {actionLabel}.
 * `ref` = заявка (`approval_request`) — строка раскрывается в рич-карту с решением.
 */
export const APPROVALS_NOTIFICATIONS = defineNotifications({
  'approval.requested': { service: 'approvals', priority: 'high', icon: 'checkCircle', contexts: 'both', collapse: 'ref', lockable: true },
  // Напоминание ДО срока — только адресатам, автору тревожиться нечем
  'approval.due_soon': { service: 'approvals', priority: 'high', icon: 'clock', contexts: 'both', collapse: 'ref' },
  'approval.overdue': { service: 'approvals', priority: 'high', icon: 'overdue', contexts: 'both', collapse: 'ref' },
  'approval.resolved': { service: 'approvals', priority: 'normal', icon: 'sealCheck', contexts: 'both', collapse: 'ref' },
  // Тупик маршрута: шаг адресован пустому отделу/должности — автор узнаёт сразу
  'approval.unassigned': { service: 'approvals', priority: 'high', icon: 'warning', contexts: 'both', collapse: 'ref' },
});
