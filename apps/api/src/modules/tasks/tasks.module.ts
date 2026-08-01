import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksCron } from './tasks.cron';
import { TasksRichCardsProvider } from './tasks-rich-cards.provider';
import { TasksCalendarProvider } from './tasks-calendar.provider';
import { WalletModule } from '../wallet/wallet.module';
import { MessengerModule } from '../messenger/messenger.module';
import { CalendarModule } from '../calendar/calendar.module';
import { DriveModule } from '../drive/drive.module';

@Module({
  // CalendarModule — регистрация слоя «Задачи» в календаре-платформе
  // (TasksCalendarProvider); обратного импорта нет — календарь потребителей не знает.
  // DriveModule — ради реестра маршрутизации: задача сама объявляет, на чей Диск
  // складывать свои вложения (организации или личный).
  imports: [WalletModule, MessengerModule, CalendarModule, DriveModule],
  controllers: [TasksController],
  providers: [TasksService, TasksCron, TasksRichCardsProvider, TasksCalendarProvider],
  exports: [TasksService],
})
export class TasksModule {}
