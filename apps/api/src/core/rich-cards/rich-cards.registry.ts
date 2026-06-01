import { Injectable, Logger } from '@nestjs/common';
import type { RichCardRefType, RichCardActionKey } from '@superapp/shared';
import type { RichCardRenderer, RichCardActionDef } from './rich-card.types';

/**
 * A reusable, cross-service registry of rich-card renderers + action handlers. Feature
 * services register their own entries on module init (Part 3F) — the registry holds no
 * service logic, so core/rich-cards depends on nothing and there is no core→service cycle.
 * Modeled on Slack Block Kit action_id routing.
 */
@Injectable()
export class RichCardRegistry {
  private readonly logger = new Logger(RichCardRegistry.name);
  private readonly renderers = new Map<RichCardRefType, RichCardRenderer>();
  private readonly actions = new Map<RichCardActionKey, RichCardActionDef>();

  registerRenderer(refType: RichCardRefType, renderer: RichCardRenderer): void {
    if (this.renderers.has(refType)) {
      this.logger.warn(`renderer for "${refType}" already registered — overwriting`);
    }
    this.renderers.set(refType, renderer);
  }

  registerAction(actionKey: RichCardActionKey, def: RichCardActionDef): void {
    if (this.actions.has(actionKey)) {
      this.logger.warn(`action "${actionKey}" already registered — overwriting`);
    }
    this.actions.set(actionKey, def);
  }

  getRenderer(refType: string): RichCardRenderer | undefined {
    return this.renderers.get(refType as RichCardRefType);
  }

  getAction(actionKey: string): RichCardActionDef | undefined {
    return this.actions.get(actionKey as RichCardActionKey);
  }
}
