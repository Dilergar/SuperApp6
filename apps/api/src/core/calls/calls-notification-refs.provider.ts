import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { intersect } from '../notifications/notifications.ref-helpers';

/** Запись звонка (сбой записи — включившему её). */
@Injectable()
export class CallsNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('call_recording', {
      canViewMany: async (userIds, id) => {
        const rec = await this.db.callRecording.findUnique({ where: { id }, select: { startedById: true } });
        return rec ? intersect(userIds, [rec.startedById]) : [];
      },
      href: () => null,
    });
  }
}
