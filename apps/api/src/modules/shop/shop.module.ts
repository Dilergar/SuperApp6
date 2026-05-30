import { Module } from '@nestjs/common';
import { ShopService } from './shop.service';
import { ShopController } from './shop.controller';
import { ShopEventsListener } from './shop.events';
import { ShopCron } from './shop.cron';
import { WalletModule } from '../wallet/wallet.module';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';

/**
 * My Wish & Shop. Catalog + sharing/staff/management decided by the @Global AccessService
 * (core/access). Purchases use the wallet escrow engine (refType='order') → WalletModule.
 * «С задачей» fulfilment (Phase 4) creates Tasks / Calendar events → TasksModule + CalendarModule,
 * and ShopEventsListener captures the order when the fulfilment task completes. ShopCron (Phase 7)
 * auto-archives expired lots + refunds expired campaigns under a Redis lock. DatabaseService,
 * AccessService, WorkspaceContextService and EventBus are @Global — no extra imports.
 */
@Module({
  imports: [WalletModule, TasksModule, CalendarModule],
  controllers: [ShopController],
  providers: [ShopService, ShopEventsListener, ShopCron],
  exports: [ShopService],
})
export class ShopModule {}
