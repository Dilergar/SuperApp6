import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService, AppEvent } from '../../shared/events/event-bus.service';
import { ShopService } from './shop.service';

/**
 * Bridges Tasks → Shop for «с задачей» fulfilment. When a fulfilment task is completed (the buyer
 * accepted the delivery), the linked order's escrow is captured. Fires for EVERY task.completed;
 * ShopService.onFulfillmentDone no-ops unless a confirmed order links that task.
 */
@Injectable()
export class ShopEventsListener implements OnModuleInit {
  private readonly logger = new Logger(ShopEventsListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly shop: ShopService,
  ) {}

  onModuleInit() {
    this.events.onPattern('task.*').subscribe((event) => {
      this.handle(event).catch((err) =>
        this.logger.warn(
          `shop fulfilment handler failed for ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  }

  private async handle(event: AppEvent) {
    if (event.type !== 'task.completed') return;
    const taskId = event.payload['taskId'] as string | undefined;
    if (taskId) await this.shop.onFulfillmentDone(taskId);
  }
}
