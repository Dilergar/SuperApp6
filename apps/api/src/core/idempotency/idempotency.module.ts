import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { isDevEnv } from '../../shared/config/env.validation';
import { IdempotencyCron } from './idempotency.cron';
import { IdempotencyDevController } from './idempotency.dev';
import { IdempotencyFingerprint } from './idempotency.fingerprint';
import { IdempotencyInboxService } from './idempotency.inbox.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyLifecycleProvider } from './idempotency.lifecycle.provider';
import { IdempotencyMetrics } from './idempotency.metrics';
import { IdempotencyPartitions } from './idempotency.partitions';
import { IdempotencyPlatformProvider } from './idempotency.platform.provider';
import { IdempotencyReplayRegistry } from './idempotency.replay.registry';
import { IdempotencyResponses } from './idempotency.responses';
import { IdempotencyRoutesAudit } from './idempotency.routes.audit';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyStore } from './idempotency.store';

/**
 * core/idempotency — движок идемпотентности повторов (25-й): HTTP-ключ повтора,
 * «входящий ящик» ровно-одного-раза и производные ключи вниз по стеку.
 *
 * @Global и с ЯВНЫМ экспортом всего, что нужно интерцептору: APP_INTERCEPTOR
 * поднимается корневым модулем, и его зависимости обязаны резолвиться из корня
 * (урок движка ключей — APP_GUARD требует того же).
 *
 * Модуль подключается ПОСЛЕ KeysModule: отпечаток запроса и шифр снимка живут в
 * keystore. Привязка отметки к бизнес-транзакции — не здесь, а в фабрике клиента
 * базы (`shared/idempotency/binding.ts`): движки ядро не импортирует.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: isDevEnv() ? [IdempotencyDevController] : [],
  providers: [
    IdempotencyStore,
    IdempotencyFingerprint,
    IdempotencyPartitions,
    IdempotencyResponses,
    IdempotencyReplayRegistry,
    IdempotencyMetrics,
    IdempotencyService,
    IdempotencyInboxService,
    IdempotencyInterceptor,
    IdempotencyRoutesAudit,
    IdempotencyPlatformProvider,
    IdempotencyLifecycleProvider,
    IdempotencyCron,
  ],
  exports: [
    IdempotencyStore,
    IdempotencyFingerprint,
    IdempotencyResponses,
    IdempotencyReplayRegistry,
    IdempotencyMetrics,
    IdempotencyService,
    IdempotencyInboxService,
    IdempotencyInterceptor,
  ],
})
export class IdempotencyModule {}
