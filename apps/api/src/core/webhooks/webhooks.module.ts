import { Global, Module } from '@nestjs/common';
import { WebhooksCatalogController, WebhooksController } from './webhooks.controller';
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
  controllers: [WebhooksCatalogController, WebhooksController],
  providers: [WebhooksRegistry, WebhooksService, WebhooksDeliveryJobs, WebhooksProbeCron],
  exports: [WebhooksService, WebhooksRegistry, WebhooksDeliveryJobs, WebhooksProbeCron],
})
export class WebhooksModule {}
