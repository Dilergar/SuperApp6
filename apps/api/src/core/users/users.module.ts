import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AccountCron } from './account.cron';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountCron],
  exports: [UsersService],
})
export class UsersModule {}
