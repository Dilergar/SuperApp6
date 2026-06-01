import { Injectable, Logger } from '@nestjs/common';
import type { QuickActionRegistration } from './quick-actions.types';

/**
 * Cross-service registry of chat quick actions (the ＋-menu + message corner-menu items).
 * Feature services register on module init; the engine holds no domain logic. Insertion
 * order = menu order. Same shape as core/rich-cards' registry.
 */
@Injectable()
export class QuickActionRegistry {
  private readonly logger = new Logger(QuickActionRegistry.name);
  private readonly actions = new Map<string, QuickActionRegistration>();

  register(action: QuickActionRegistration): void {
    if (this.actions.has(action.key)) {
      this.logger.warn(`quick action "${action.key}" already registered — overwriting`);
    }
    this.actions.set(action.key, action);
  }

  all(): QuickActionRegistration[] {
    return [...this.actions.values()];
  }
}
