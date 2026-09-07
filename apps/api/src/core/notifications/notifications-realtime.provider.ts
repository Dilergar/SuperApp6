import { Injectable, OnModuleInit } from '@nestjs/common';
import type { NotificationsCountsBusPayload, NotificationsCreatedBusPayload, WsNotificationCounts, WsNotificationNew } from '@superapp/shared';
import { RealtimeRegistry } from '../realtime/realtime.registry';
import { NOTIFICATION_BUS_EVENTS } from './notifications.constants';

/**
 * Уведомления → сокет: `notifications.created` → `notification:new` каждому адресату
 * (свой notificationId и контекст → бейдж +1, голова ленты), `notifications.counts` →
 * `notification:counts` (seen/read в другой вкладке — клиент перечитывает counts).
 * Потеря допустима: шина at-most-once, клиент перечитывает counts на reconnect.
 */
@Injectable()
export class NotificationsRealtimeProvider implements OnModuleInit {
  constructor(private readonly realtime: RealtimeRegistry) {}

  onModuleInit(): void {
    this.realtime.registerRelay(NOTIFICATION_BUS_EVENTS.created, ({ payload }) => {
      const p = payload as NotificationsCreatedBusPayload;
      if (!p?.recipients?.length) return null;
      return p.recipients.map((r) => {
        const msg: WsNotificationNew = { notificationId: r.notificationId, context: r.context, unseen: r.unseen, type: p.type };
        return { rooms: [`user:${r.userId}`], name: 'notification:new', payload: msg };
      });
    });
    this.realtime.registerRelay(NOTIFICATION_BUS_EVENTS.counts, ({ payload }) => {
      const p = payload as NotificationsCountsBusPayload;
      if (!p?.userId) return null;
      const msg: WsNotificationCounts = { reason: p.reason };
      return { rooms: [`user:${p.userId}`], name: 'notification:counts', payload: msg };
    });
  }
}
