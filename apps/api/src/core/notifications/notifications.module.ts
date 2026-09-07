import { Global, Module, OnModuleInit } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsRenderer } from './notifications.render';
import { NotificationsPreferencesService } from './notifications.preferences.service';
import { NotificationsPolicyService } from './notifications.policy.service';
import { NotificationsSettingsService } from './notifications.settings.service';
import { NotificationsFanout } from './notifications.fanout';
import { NotificationsDelivery } from './notifications.delivery';
import { NotificationsCron } from './notifications.cron';
import { NotificationsController } from './notifications.controller';
import { NotificationsPolicyController } from './notifications.policy.controller';
import { NotificationChannelRegistry, NotificationRefRegistry, PresenceProviderRegistry } from './notifications.registry';
import { WebPushDriver } from './channels/webpush.driver';
import { NullEmailDriver } from './channels/email.driver';
import { NotificationsRealtimeProvider } from './notifications-realtime.provider';

/**
 * core/notifications — 17-й платформенный движок: уведомления как событие + строка на
 * адресата + журнал доставки; каналы in-app/realtime · web push · SMS (critical + opt-in) ·
 * chat (драйвер регистрирует мессенджер) · email (контракт). @Global: любой сервис зовёт
 * `NotificationsService.send(tx, …)`, владельцы сущностей регистрируют резолверы в
 * `NotificationRefRegistry`, мессенджер — presence и chat-драйвер. Движок фичи не импортирует.
 */
@Global()
@Module({
  controllers: [NotificationsController, NotificationsPolicyController],
  providers: [
    NotificationChannelRegistry,
    NotificationRefRegistry,
    PresenceProviderRegistry,
    NotificationsRenderer,
    NotificationsService,
    NotificationsPreferencesService,
    NotificationsPolicyService,
    NotificationsSettingsService,
    NotificationsFanout,
    NotificationsDelivery,
    NotificationsCron,
    WebPushDriver,
    NullEmailDriver,
    NotificationsRealtimeProvider,
  ],
  exports: [NotificationsService, NotificationChannelRegistry, NotificationRefRegistry, PresenceProviderRegistry, NotificationsRenderer],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly channels: NotificationChannelRegistry,
    private readonly webPush: WebPushDriver,
    private readonly email: NullEmailDriver,
  ) {}

  onModuleInit(): void {
    this.channels.registerPush(this.webPush);
    this.channels.registerEmail(this.email);
  }
}
