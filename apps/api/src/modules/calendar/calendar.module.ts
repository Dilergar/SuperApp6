import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { CalendarCron } from './calendar.cron';
import { ResourcesService } from './resources.service';
import { ResourcesController } from './resources.controller';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [TasksModule],
  controllers: [CalendarController, ResourcesController],
  providers: [CalendarService, CalendarCron, ResourcesService],
  exports: [CalendarService],
})
export class CalendarModule {}
