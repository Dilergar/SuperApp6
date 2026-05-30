import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';

// Shared infrastructure
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';
import { EventBusModule } from './shared/events/event-bus.module';
import { WorkspaceContextModule } from './shared/context/workspace-context.module';

// Core modules
import { AuthModule } from './core/auth/auth.module';
import { UsersModule } from './core/users/users.module';
import { RolesModule } from './core/roles/roles.module';
import { AccessModule } from './core/access/access.module';

// Feature modules (MVP)
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { CirclesModule } from './modules/circles/circles.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { GoogleCalendarModule } from './modules/google-calendar/google-calendar.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { ShopModule } from './modules/shop/shop.module';

import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';
import { WorkspaceContextInterceptor } from './shared/interceptors/workspace-context.interceptor';
import { ZodExceptionFilter } from './shared/filters/zod-exception.filter';
import { RedisService } from './shared/redis/redis.service';
import { RedisThrottlerStorage } from './shared/throttler/redis-throttler.storage';

@Module({
  imports: [
    // Rate limiting — counters stored in Redis so limits hold across instances.
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [
          { name: 'short', ttl: 1000, limit: 10 },
          { name: 'medium', ttl: 10000, limit: 50 },
          { name: 'long', ttl: 60000, limit: 200 },
        ],
        storage: new RedisThrottlerStorage(redis),
        // Enforce rate limiting only in production. In development you log in/out
        // constantly, so throttling just gets in the way; prod keeps full protection.
        skipIf: () => process.env.NODE_ENV !== 'production',
      }),
    }),

    // Scheduler for cron jobs
    ScheduleModule.forRoot(),

    // Shared infrastructure — available to all modules
    WorkspaceContextModule,
    DatabaseModule,
    RedisModule,
    EventBusModule,

    // Core — auth, users & universal identity
    AuthModule,
    UsersModule,
    RolesModule,
    // Unified authorization engine (ReBAC). Phase 0: core only, no consumers yet.
    AccessModule,

    // Feature modules — each is self-contained.
    // Load order: Notifications → Contacts (@Global, consumed by AuthService)
    // → Circles (depends on ContactsService).
    NotificationsModule,
    ContactsModule,
    CirclesModule,
    // Wallet — issued currencies + immutable ledger; underpins task coin rewards (escrow).
    WalletModule,
    TasksModule,
    CalendarModule,
    GoogleCalendarModule,
    WorkspacesModule,
    ShopModule,
  ],
  providers: [
    // Map Zod validation errors (controller schema.parse) to 400 app-wide.
    {
      provide: APP_FILTER,
      useClass: ZodExceptionFilter,
    },
    // Order matters: throttler runs first so abusive traffic is rejected
    // before we do any JWT/DB work.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Establishes the active-workspace context (chokepoint) after auth runs.
    {
      provide: APP_INTERCEPTOR,
      useClass: WorkspaceContextInterceptor,
    },
  ],
})
export class AppModule {}
