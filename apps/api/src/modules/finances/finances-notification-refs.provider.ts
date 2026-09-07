import { Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';

/** Финансы B2C: адресат — владелец книги или человек, которому её только что открыли; отсев не нужен. */
@Injectable()
export class FinancesNotificationRefsProvider implements OnModuleInit {
  constructor(private readonly refs: NotificationRefRegistry) {}

  onModuleInit(): void {
    this.refs.register('fin_book', {
      canViewMany: async (userIds) => userIds,
      href: (ref) => `/finance?book=${ref.id}`,
    });
    // id составной `<bookId>:<categoryAccountId>:<period>` — ключ схлопывания «лимит категории за период»
    this.refs.register('fin_budget', {
      canViewMany: async (userIds) => userIds,
      href: () => '/finance',
    });
  }
}
