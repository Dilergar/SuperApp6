import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsDispatch } from './notifications.dispatch';
import { NotificationsCron } from './notifications.cron';

/**
 * NotificationsModule — cross-cutting concern, marked @Global() so any module
 * injects NotificationsService without re-importing. Доменные события эмиттеры
 * шлют через `notifications.emitEvent` (шина + джоб notifications.dispatch —
 * Волна 1 движка джобов: создание строк надёжно, at-least-once + dedupKey);
 * прямой notify() — для точечных немедленных уведомлений (mentions, finances,
 * office, recorder и т.п.).
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsDispatch, NotificationsCron],
  exports: [NotificationsService],
})
export class NotificationsModule {}
