import { Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';

/**
 * Узел Диска: адресат шеринга получил грант в той же операции — отсев не нужен
 * (права узла считает предикат Диска по живым tuples, а не батч движка прав).
 */
@Injectable()
export class DriveNotificationRefsProvider implements OnModuleInit {
  constructor(private readonly refs: NotificationRefRegistry) {}

  onModuleInit(): void {
    this.refs.register('drive_node', {
      canViewMany: async (userIds) => userIds,
      href: (ref) => `/drive/n/${ref.id}`,
      richCardType: 'drive_node',
    });
  }
}
