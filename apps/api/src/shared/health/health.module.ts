import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthRegistry } from './health.registry';
import { HealthService } from './health.service';

/**
 * Пробы `/health/live|ready`. @Global — движки регистрируют свои проверки готовности в
 * `HealthRegistry` без импорта модуля (core/lifecycle: партиции вперёд, свежесть бэкапов).
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [HealthRegistry, HealthService],
  exports: [HealthRegistry],
})
export class HealthModule {}
