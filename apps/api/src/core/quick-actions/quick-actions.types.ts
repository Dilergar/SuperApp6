import type { QuickActionDescriptor } from '@superapp/shared';

/** The chat context handed to an action's availability gate. */
export interface QuickActionContext {
  viewerId: string;
  chatId: string;
  chatType: string;
  parentType: string | null;
  workspaceId: string | null;
}

/**
 * A registered quick action = the public descriptor + an optional availability gate. Feature
 * services register these on module init; the engine stays domain-agnostic (no core→feature
 * import), same as core/rich-cards & core/search.
 */
export interface QuickActionRegistration extends QuickActionDescriptor {
  /** Optional gate (chat context / capability). Omitted → available in any chat the viewer can post to. */
  isAvailable?: (ctx: QuickActionContext) => boolean | Promise<boolean>;
}
