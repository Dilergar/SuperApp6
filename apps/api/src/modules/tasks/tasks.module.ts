import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksCron } from './tasks.cron';
import { TasksRichCardsProvider } from './tasks-rich-cards.provider';
import { WalletModule } from '../wallet/wallet.module';
import { MessengerModule } from '../messenger/messenger.module';

@Module({
  imports: [WalletModule, MessengerModule],
  controllers: [TasksController],
  providers: [TasksService, TasksCron, TasksRichCardsProvider],
  exports: [TasksService],
})
export class TasksModule {}
