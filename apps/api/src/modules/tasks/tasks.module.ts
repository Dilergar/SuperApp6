import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TaskEventsListener } from './tasks.events';

@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskEventsListener],
  exports: [TasksService],
})
export class TasksModule {}
