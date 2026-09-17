import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Наблюдаемость: реестр Prometheus-метрик и его выдача. @Global — движки (`core/keys`,
 * `core/webhooks`) инжектят `MetricsService` без импорта модуля. Ничего не хранит и
 * не пишет: метрики живут в памяти процесса и читаются скрейпом.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
