import { Global, Module } from '@nestjs/common';
import { isDevEnv } from '../../shared/config/env.validation';
import { WebhooksCatalogController, WebhooksController } from './webhooks.controller';
import { WebhooksDevController } from './webhooks.dev';
import { WebhooksPlatformProvider } from './webhooks.platform';
import { WebhooksDeliveryJobs } from './webhooks.delivery.job';
import { WebhooksProbeCron } from './webhooks.probe.cron';
import { WebhooksRegistry } from './webhooks.registry';
import { WebhooksService } from './webhooks.service';

/**
 * core/webhooks — 23-й движок: исходящие вебхуки организаций. @Global: продюсеры
 * (tasks, documents, workspaces, …) инжектят `WebhooksService.emit(tx, …)` напрямую;
 * движок фичи не импортирует — события живут реестром в shared.
 */
@Global()
@Module({
  // Дев-полигон — только в development/test: в production контроллера нет вовсе
  controllers: isDevEnv() ? [WebhooksCatalogController, WebhooksController, WebhooksDevController] : [WebhooksCatalogController, WebhooksController],
  providers: [WebhooksRegistry, WebhooksService, WebhooksDeliveryJobs, WebhooksProbeCron, WebhooksPlatformProvider],
  exports: [WebhooksService, WebhooksRegistry, WebhooksDeliveryJobs, WebhooksProbeCron],
})
export class WebhooksModule {}
