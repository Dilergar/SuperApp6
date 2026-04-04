import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

// Shared infrastructure
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';
import { EventBusModule } from './shared/events/event-bus.module';

// Core modules
import { AuthModule } from './core/auth/auth.module';
import { UsersModule } from './core/users/users.module';

// Feature modules (MVP)
import { CirclesModule } from './modules/circles/circles.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CalendarModule } from './modules/calendar/calendar.module';

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

    // Shared infrastructure — available to all modules
    DatabaseModule,
    RedisModule,
    EventBusModule,

    // Core — auth & users
    AuthModule,
    UsersModule,

    // Feature modules — each is self-contained
    CirclesModule,
    TasksModule,
    CalendarModule,
  ],
})
export class AppModule {}
