import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';

// Shared infrastructure
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';
import { EventBusModule } from './shared/events/event-bus.module';

// Core modules
import { AuthModule } from './core/auth/auth.module';
import { UsersModule } from './core/users/users.module';
import { RolesModule } from './core/roles/roles.module';

// Feature modules (MVP)
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { CirclesModule } from './modules/circles/circles.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CalendarModule } from './modules/calendar/calendar.module';

import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';

@Module({
  imports: [
    // Rate limiting
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 10,
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 50,
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 200,
      },
    ]),

    // Scheduler for cron jobs
    ScheduleModule.forRoot(),

    // Shared infrastructure — available to all modules
    DatabaseModule,
    RedisModule,
    EventBusModule,

    // Core — auth, users & universal identity
    AuthModule,
    UsersModule,
    RolesModule,

    // Feature modules — each is self-contained.
    // Load order: Notifications → Contacts (@Global, consumed by AuthService)
    // → Circles (depends on ContactsService).
    NotificationsModule,
    ContactsModule,
    CirclesModule,
    TasksModule,
    CalendarModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
