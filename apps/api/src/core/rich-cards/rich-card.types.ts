import type { RichCardPayload, RichCardRefType, RichCardActionKey } from '@superapp/shared';
import type { DatabaseService } from '../../shared/database/database.service';
import type { AccessService } from '../access/access.service';
import type { CapabilityKey } from '../access/access-capabilities';

/**
 * Dependencies handed to a renderer. Keep this minimal & stable — services register
 * their own renderers/actions (Part 3F) and close over their own injected services,
 * so the registry never imports a feature service (no core→service cycle).
 */
export interface RichCardDeps {
  db: DatabaseService;
  access: AccessService;
}

/**
 * Builds the LIVE card for `refId` as seen by `viewerId`. Returns null if the entity is
 * gone or the viewer can't see it. The renderer is responsible for permission/state
 * filtering of the action buttons (e.g. only show "order.confirm" to the seller when the
 * order is 'pending').
 */
export type RichCardRenderer = (
  deps: RichCardDeps,
  viewerId: string,
  refId: string,
) => Promise<RichCardPayload | null>;

/**
 * A server-side action handler routed by action key. `requiredCapability` (if set) is
 * re-checked against the engine before the handler runs; the handler itself may also do
 * finer-grained domain checks (e.g. "is the buyer").
 */
export interface RichCardActionDef {
  handler: (userId: string, refId: string, payload?: Record<string, unknown>) => Promise<void>;
  requiredCapability?: CapabilityKey;
}

export type { RichCardRefType, RichCardActionKey };
