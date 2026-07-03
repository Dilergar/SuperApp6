// Capability registry: the STABLE vocabulary services check against. Code asks
// `can(user, 'showcase.view', id)` — never role names. A capability maps to a
// (resourceType, relation) the engine resolves. New services add new keys here;
// granting that capability to a person / Group / role / department / position is
// just writing a tuple — no code change to the checker.

export interface CapabilityDef {
  resourceType: string;
  relation: string;
}

export const CAPABILITIES = {
  // shop / showcase
  'shop.manage': { resourceType: 'shop', relation: 'manager' },
  'showcase.view': { resourceType: 'showcase', relation: 'viewer' },
  'showcase.manage': { resourceType: 'showcase', relation: 'manager' },
  // wishlist (one per user, shared like a showcase)
  'wishlist.view': { resourceType: 'wishlist', relation: 'viewer' },
  // finances — учётная книга (whole-book sharing: «смотрит» / «ведёт вместе»)
  'finbook.view': { resourceType: 'finbook', relation: 'viewer' },
  'finbook.edit': { resourceType: 'finbook', relation: 'editor' },
  // calendar
  'calendar.view_busy': { resourceType: 'calendar', relation: 'busy_viewer' },
  'calendar.view_detailed': { resourceType: 'calendar', relation: 'detailed_viewer' },
  // card
  'card.view': { resourceType: 'card', relation: 'viewer' },
  'card.view_full': { resourceType: 'card', relation: 'full_viewer' }, // B2B full employee card (else floor: Имя+Должность)
  // task
  'task.view': { resourceType: 'task', relation: 'viewer' },
  'task.comment': { resourceType: 'task', relation: 'viewer' },
  // workspace
  'workspace.admin': { resourceType: 'workspace', relation: 'admin' },
  'workspace.member': { resourceType: 'workspace', relation: 'member' },
  // platform personas (gate FUTURE features; nothing existing is restricted)
  'marketplace.sell': { resourceType: 'platform', relation: 'seller' },
  'jobs.mystery_guest': { resourceType: 'platform', relation: 'mystery_guest' },
  'content.ugc': { resourceType: 'platform', relation: 'ugc_blogger' },
  'chat.view': { resourceType: 'chat', relation: 'viewer' },
  'chat.post': { resourceType: 'chat', relation: 'viewer' },
  // order / event (Phase 3 context chats + rich-card action gating)
  'order.view': { resourceType: 'order', relation: 'viewer' },
  'order.manage': { resourceType: 'order', relation: 'seller' },
  'event.view': { resourceType: 'event', relation: 'viewer' },
} as const satisfies Record<string, CapabilityDef>;

export type CapabilityKey = keyof typeof CAPABILITIES;
