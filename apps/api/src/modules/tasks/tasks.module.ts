import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TaskEventsListener } from './tasks.events';
import { TasksCron } from './tasks.cron';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [TasksController],
  providers: [TasksService, TaskEventsListener, TasksCron],
  exports: [TasksService],
})
export class TasksModule {}
