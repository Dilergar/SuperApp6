import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Запись Диктофона: видит владелец строки. */
@Injectable()
export class RecorderNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('voice_recording', {
      canViewMany: async (userIds, id) => {
        const rec = await this.db.voiceRecording.findUnique({ where: { id, deletedAt: null }, select: { ownerId: true } });
        return rec ? intersect(userIds, [rec.ownerId]) : [];
      },
      href: (ref) => `/recorder?id=${ref.id}`,
    });
  }
}
