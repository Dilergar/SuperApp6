import { Injectable, Logger } from '@nestjs/common';
import type { SearchSourceType } from '@superapp/shared';
import type { SearchProvider } from './search.types';

/**
 * Cross-service registry of search providers. Feature services register their providers on
 * module init; the engine holds no domain logic, so core/search depends on nothing and there
 * is no core→service cycle (same shape as core/rich-cards' registry).
 *
 * Insertion order is preserved — it drives the order of groups in a global search
 * (e.g. messenger registers chat → person → message).
 */
@Injectable()
export class SearchRegistry {
  private readonly logger = new Logger(SearchRegistry.name);
  private readonly providers = new Map<SearchSourceType, SearchProvider>();

  register(provider: SearchProvider): void {
    if (this.providers.has(provider.type)) {
      this.logger.warn(`search provider for "${provider.type}" already registered — overwriting`);
    }
    this.providers.set(provider.type, provider);
  }

  get(type: string): SearchProvider | undefined {
    return this.providers.get(type as SearchSourceType);
  }

  /** Registered source types, in registration order. */
  types(): SearchSourceType[] {
    return [...this.providers.keys()];
  }

  all(): SearchProvider[] {
    return [...this.providers.values()];
  }
}
