import type { NotificationType } from '@superapp/shared';

/**
 * Карта «событие платформы → кому какие уведомления» (Волна 1 движка джобов).
 *
 * Раньше жила в NotificationsEventsListener на шине (at-most-once → потери);
 * теперь эмиттер ставит джоб `notifications.dispatch` через
 * `NotificationsService.emitEvent` (шина остаётся для остальных листенеров),
 * а обработчик джоба (NotificationsDispatch) раскладывает событие по этой карте.
 * Правило прежнее: одно событие → ноль и больше строк уведомлений; семантика —
 * в одном месте, эмиттеры знают только тип события и payload.
 *
 * Чистая функция без БД: все адресаты и переменные шаблонов — из payload события.
 */

/** Тип джоба раскладки (core/jobs); payload = { event, data }. */
export const NOTIFY_DISPATCH_JOB = 'notifications.dispatch';

export interface NotificationTarget {
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  actionUrl: string | null;
}

/** События, дающие уведомления, — только они ставят джоб (emitEvent сверяется). */
export const MAPPED_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Окружение
  'contact.invitation.sent',
  'contact.invitation.activated',
  'contact.invitation.accepted',
  'contact.invitation.rejected',
  'contact.invitation.cancelled',
  'contact.linked',
  'contact.removed',
  // Задачи (task.created/updated/deleted — НЕ уведомления)
  'task.assigned',
  'task.submitted',
  'task.accepted',
  'task.returned',
  'task.completed',
  'task.due_soon',
  'task.overdue',
  // Календарь
  'calendar.event.reminder',
  'calendar.event.invited',
  'calendar.event.updated',
  'calendar.event.cancelled',
  'calendar.event.rsvp',
  // Организации (B2B)
  'workspace.invitation.sent',
  'workspace.invitation.accepted',
  'workspace.invitation.rejected',
  'workspace.member.removed',
  'workspace.role.changed',
  'workspace.position.assigned',
  'workspace.position.certified',
  // Кошелёк
  'wallet.coins.received',
  // Магазин
  'shop.order.placed',
  'shop.order.confirmed',
  'shop.order.rejected',
  'shop.order.cancelled',
  'shop.order.funded',
]);

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export function mapEventToNotifications(
  eventType: string,
  payload: Record<string, unknown>,
): NotificationTarget[] {
  // ------------------------------------------------------------
  // Окружение
  // ------------------------------------------------------------
  switch (eventType) {
    case 'contact.invitation.sent':
    case 'contact.invitation.activated': {
      const toUserId = str(payload['toUserId']);
      if (!toUserId) return [];
      return [{ userId: toUserId, type: 'contact.invitation.received', payload, actionUrl: null }];
    }
    case 'contact.invitation.accepted':
    case 'contact.invitation.rejected': {
      const fromUserId = str(payload['fromUserId']);
      if (!fromUserId) return [];
      return [{ userId: fromUserId, type: eventType as NotificationType, payload, actionUrl: null }];
    }
    case 'contact.invitation.cancelled': {
      const toUserId = str(payload['toUserId']);
      if (!toUserId) return [];
      return [{ userId: toUserId, type: 'contact.invitation.cancelled', payload, actionUrl: null }];
    }
    case 'contact.linked': {
      const userIds = (payload['userIds'] as string[] | undefined) ?? [];
      return userIds.map((uid) => ({
        userId: uid,
        type: 'contact.linked' as NotificationType,
        payload: {
          ...payload,
          otherUserId: userIds.find((id) => id !== uid) ?? '',
          otherName: payload['otherNameByUser']
            ? ((payload['otherNameByUser'] as Record<string, string>)[uid] ?? '')
            : '',
        },
        actionUrl: null,
      }));
    }
    case 'contact.removed': {
      const userIds = (payload['userIds'] as string[] | undefined) ?? [];
      return userIds.map((uid) => ({
        userId: uid,
        type: 'contact.removed' as NotificationType,
        payload,
        actionUrl: null,
      }));
    }
    default:
      break;
  }

  // ------------------------------------------------------------
  // Задачи — recipientIds[] + актор byUserId (его не уведомляем)
  // ------------------------------------------------------------
  if (eventType.startsWith('task.')) {
    const recipientIds = (payload['recipientIds'] as string[] | undefined) ?? [];
    const actorId = str(payload['byUserId']);
    const taskId = str(payload['taskId']);
    const actionUrl = taskId ? `/tasks/${taskId}` : null;
    return [...new Set(recipientIds)]
      .filter((uid) => uid !== actorId)
      .map((uid) => ({ userId: uid, type: eventType as NotificationType, payload, actionUrl }));
  }

  // ------------------------------------------------------------
  // Календарь — reminder адресует одного; остальные recipientIds[] минус актор
  // ------------------------------------------------------------
  if (eventType.startsWith('calendar.')) {
    const eventId = str(payload['eventId']);
    const actionUrl = eventId ? `/calendar?event=${eventId}` : '/calendar';
    if (eventType === 'calendar.event.reminder') {
      const userId = str(payload['userId']);
      if (!userId) return [];
      return [{ userId, type: 'calendar.event.reminder', payload, actionUrl }];
    }
    const recipientIds = (payload['recipientIds'] as string[] | undefined) ?? [];
    const actorId = str(payload['byUserId']);
    return [...new Set(recipientIds)]
      .filter((uid) => uid !== actorId)
      .map((uid) => ({ userId: uid, type: eventType as NotificationType, payload, actionUrl }));
  }

  // ------------------------------------------------------------
  // Организации (B2B)
  // ------------------------------------------------------------
  if (eventType.startsWith('workspace.')) {
    const workspaceId = str(payload['workspaceId']);
    const wsUrl = workspaceId ? `/workspaces/${workspaceId}` : null;
    switch (eventType) {
      case 'workspace.invitation.sent': {
        // Уведомляем приглашённого (когда номер зарегистрирован → toUserId известен).
        const toUserId = str(payload['toUserId']);
        if (!toUserId) return [];
        return [{ userId: toUserId, type: 'workspace.invitation.received', payload, actionUrl: '/dashboard' }];
      }
      case 'workspace.invitation.accepted':
      case 'workspace.invitation.rejected': {
        const inviterId = str(payload['inviterId']);
        if (!inviterId) return [];
        return [{ userId: inviterId, type: eventType as NotificationType, payload, actionUrl: wsUrl }];
      }
      case 'workspace.member.removed': {
        const userId = str(payload['userId']);
        if (!userId) return [];
        return [{ userId, type: 'workspace.member.removed', payload, actionUrl: null }];
      }
      case 'workspace.role.changed':
      case 'workspace.position.assigned':
      case 'workspace.position.certified': {
        const userId = str(payload['userId']);
        if (!userId) return [];
        return [{ userId, type: eventType as NotificationType, payload, actionUrl: wsUrl }];
      }
      default:
        return [];
    }
  }

  // ------------------------------------------------------------
  // Кошелёк — выплата коинов при приёмке задачи
  // ------------------------------------------------------------
  if (eventType === 'wallet.coins.received') {
    const recipientIds = (payload['recipientIds'] as string[] | undefined) ?? [];
    const taskId = str(payload['taskId']);
    const actionUrl = taskId ? `/tasks/${taskId}` : '/profile/wallet';
    return [...new Set(recipientIds)].map((uid) => ({
      userId: uid,
      type: 'wallet.coins.received' as NotificationType,
      payload,
      actionUrl,
    }));
  }

  // ------------------------------------------------------------
  // Магазин — жизненный цикл заказа
  // ------------------------------------------------------------
  if (eventType.startsWith('shop.order.')) {
    const actionUrl = '/shop';
    const target =
      eventType === 'shop.order.confirmed' || eventType === 'shop.order.rejected'
        ? str(payload['buyerId'])
        : str(payload['sellerId']); // placed / cancelled / funded → продавец
    if (!target) return [];
    return [{ userId: target, type: eventType as NotificationType, payload, actionUrl }];
  }

  return [];
}
