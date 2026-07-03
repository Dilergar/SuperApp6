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
import { RichCardsModule } from './core/rich-cards/rich-cards.module';
import { SearchModule } from './core/search/search.module';
import { QuickActionsModule } from './core/quick-actions/quick-actions.module';

// Feature modules (MVP)
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { CirclesModule } from './modules/circles/circles.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { GoogleCalendarModule } from './modules/google-calendar/google-calendar.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { StaffModule } from './modules/staff/staff.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { ShopModule } from './modules/shop/shop.module';
import { MessengerModule } from './modules/messenger/messenger.module';
import { CardSkinsModule } from './modules/card-skins/card-skins.module';
import { ProcessesModule } from './modules/processes/processes.module';
import { FinancesModule } from './modules/finances/finances.module';

import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';
import { WorkspaceContextInterceptor } from './shared/interceptors/workspace-context.interceptor';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
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
        // Secure-by-default: throttling is DISABLED only in explicit development/test
        // (constant logins during development would hit the limits). Any other value —
        // including a typo'd "prod" — keeps full protection (env validation also
        // whitelists NODE_ENV at boot, this is the second belt).
        skipIf: () => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' || !process.env.NODE_ENV,
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
    // Reusable interactive rich-card registry + dispatcher (Phase 3). @Global; feature
    // services register their renderers/actions on init.
    RichCardsModule,
    // Unified search engine (Phase 6). @Global; feature services register providers +
    // project their items into the index. Messenger is the first consumer.
    SearchModule,
    // Chat quick-actions registry (Phase 7). @Global; services register ＋-menu / message-menu
    // actions (Создать задачу / Событие / Напомнить). Forms = modals, results = Rich Cards.
    QuickActionsModule,

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
    // Сотрудники (B2B): справочники Должность/Отдел/Филиал + назначения должностей
    // (также импортируется WorkspacesModule для ростера/каскадов).
    StaffModule,
    ShopModule,
    MessengerModule,
    // Card skins — cosmetic skins for PersonCard (platform currency + equip + per-group).
    CardSkinsModule,
    // Процессы (B2B) — нодовый движок бизнес-процессов: реестр нод + token-движок,
    // человеческий шаг = настоящая задача Задачника (синхронный хук через 'ProcessesService').
    ProcessesModule,
    // Финансы (B2C) — редактируемая учётная книга с двойной записью (Firefly-модель);
    // кошелёк-леджер коинов остаётся отдельным расчётным слоем (read-only проекция).
    FinancesModule,
  ],
  providers: [
    // ONE error envelope app-wide ({success:false, statusCode, message, errors?}):
    // Zod → 400 с полями, HttpException → как есть, Prisma P2002/P2025 → 409/404,
    // прочее → 500 + лог. Клиент парсит ошибки одной веткой.
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
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
