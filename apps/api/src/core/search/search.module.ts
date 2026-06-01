import { Global, Module } from '@nestjs/common';
import { SearchRegistry } from './search.registry';
import { SearchProjectionService } from './search-projection.service';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { SearchReconcileCron } from './search-reconcile.cron';

/**
 * Unified search engine (core/search). @Global so any feature service can inject
 * SearchRegistry (to register a provider) + SearchProjectionService (to mirror its items into
 * the index) without importing this module — same pattern as core/access & core/rich-cards.
 * NOT in the chokepoint: search is a cross-cutting concern; per-result access trimming is done
 * by each provider. DatabaseService + RedisService are @Global.
 */
@Global()
@Module({
  controllers: [SearchController],
  providers: [SearchRegistry, SearchProjectionService, SearchService, SearchReconcileCron],
  exports: [SearchRegistry, SearchProjectionService, SearchService],
})
export class SearchModule {}
