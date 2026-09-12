import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AccountCron } from './account.cron';
import { UsersPlatformProvider } from './users-platform.provider';

@Module({
  controllers: [UsersController],
  // UsersPlatformProvider — поиск людей и панель профиля в кабинете платформы (core/platform)
  providers: [UsersService, AccountCron, UsersPlatformProvider],
  exports: [UsersService],
})
export class UsersModule {}
