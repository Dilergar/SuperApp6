import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsEventsListener } from './notifications.events';

/**
 * NotificationsModule — cross-cutting concern, marked @Global() so any
 * module that wants to inject NotificationsService directly can do so
 * without re-importing. In practice most modules should go through the
 * EventBus; direct injection is reserved for cases where the emitting
 * code needs an immediate confirmation (e.g. seeding welcome notifications
 * from AuthService).
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsEventsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
