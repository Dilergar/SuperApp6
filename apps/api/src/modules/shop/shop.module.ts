import { Module } from '@nestjs/common';
import { ShopService } from './shop.service';
import { ShopController } from './shop.controller';
import { ShopEventsListener } from './shop.events';
import { ShopCron } from './shop.cron';
import { ShopRichCardsProvider } from './shop-rich-cards.provider';
import { WalletModule } from '../wallet/wallet.module';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { MessengerModule } from '../messenger/messenger.module';

/**
 * My Wish & Shop. Catalog + sharing/staff/management decided by the @Global AccessService
 * (core/access). Purchases use the wallet escrow engine (refType='order') → WalletModule.
 * «С задачей» fulfilment (Phase 4) creates Tasks / Calendar events → TasksModule + CalendarModule,
 * and ShopEventsListener captures the order when the fulfilment task completes. ShopCron (Phase 7)
 * auto-archives expired lots + refunds expired campaigns under a Redis lock. DatabaseService,
 * AccessService, WorkspaceContextService and EventBus are @Global — no extra imports.
 */
@Module({
  imports: [WalletModule, TasksModule, CalendarModule, MessengerModule],
  controllers: [ShopController],
  providers: [
    ShopService,
    // String-token alias so TasksService can settle a linked order SYNCHRONOUSLY on fulfilment-task
    // completion via ModuleRef.get('ShopService', { strict: false }) — a direct import would create
    // the cycle TasksModule→ShopModule→TasksModule. Same pattern as 'CalendarService' in calendar.module.
    { provide: 'ShopService', useExisting: ShopService },
    ShopEventsListener,
    ShopCron,
    ShopRichCardsProvider,
  ],
  exports: [ShopService],
})
export class ShopModule {}
