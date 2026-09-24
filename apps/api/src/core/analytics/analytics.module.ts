import { Global, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { analyticsRegistryProblems } from '@superapp/shared';
import { AnalyticsActivityService } from './analytics.activity.service';
import { AnalyticsCatalogService } from './analytics.catalog.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsDevController } from './analytics.dev';
import { AnalyticsCron } from './analytics.cron';
import { AnalyticsIngestService } from './analytics.ingest.service';
import { AnalyticsEraseJobs } from './analytics.jobs';
import { AnalyticsPartitions } from './analytics.partitions';
import { AnalyticsPlatformController, AnalyticsPlatformProvider } from './analytics.platform.provider';
import { AnalyticsQueryService } from './analytics.query.service';
import { AnalyticsReadDb } from './analytics.read-db';
import { AnalyticsReportsService } from './analytics.reports.service';
import { AnalyticsRollupService } from './analytics.rollup.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsLifecycleProvider } from './analytics.lifecycle.provider';

/**
 * core/analytics — 21-й платформенный движок: продуктовая аналитика. Реестр событий как
 * код в shared, приём без БД на пути запроса (Redis stream + outbox в транзакциях),
 * сырьё в партициях PostgreSQL, роллапы джобами, язык запросов и отчёты в Кабинете.
 * @Global: сервисы зовут `AnalyticsService.track(tx, …)`; движок фичи не импортирует.
 *
 * Смоук на бутстрапе: реестр, нарушающий правила (владелец ≠ первый сегмент ключа,
 * нестрогая схема, запрещённое имя свойства), роняет старт.
 */
@Global()
@Module({
  controllers: isDevEnv()
    ? [AnalyticsController, AnalyticsPlatformController, AnalyticsDevController]
    : [AnalyticsController, AnalyticsPlatformController],
  providers: [
    AnalyticsLifecycleProvider,
    AnalyticsService,
    AnalyticsPartitions,
    AnalyticsIngestService,
    AnalyticsEraseJobs,
    AnalyticsCron,
    AnalyticsReadDb,
    AnalyticsRollupService,
    AnalyticsQueryService,
    AnalyticsCatalogService,
    AnalyticsActivityService,
    AnalyticsReportsService,
    AnalyticsPlatformProvider,
  ],
  exports: [AnalyticsService, AnalyticsQueryService],
})
export class AnalyticsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsModule.name);

  onApplicationBootstrap(): void {
    const problems = analyticsRegistryProblems();
    if (problems.length) {
      const msg = `analytics event registry is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }
}
