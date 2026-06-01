// Rich Cards — interactive service-posted cards in the messenger (Phase 3).
// A reusable, cross-service registry (core/rich-cards on the backend): a service
// posts a card of a known type referencing one of its entities; buttons carry an
// ACTION KEY that a central endpoint routes to a server handler (which re-checks
// permissions). Modeled on Slack Block Kit (action_id) + MS Adaptive Cards (Action.Execute).

// What entity a card points at. The renderer fetches LIVE data by (refType, refId),
// so a card always reflects current state.
export const RICH_CARD_REF_TYPES = ['order', 'listing', 'crowdfunding', 'task', 'event'] as const;

// Button visual styles.
export const RICH_CARD_ACTION_STYLES = ['primary', 'danger', 'default'] as const;

// The STABLE vocabulary of card actions. Each maps (server-side, in core/rich-cards)
// to a handler + a required capability that is re-checked before执行. Clients never
// call service APIs directly — they POST an action key here.
export const RICH_CARD_ACTION_KEYS = [
  // shop — order
  'order.confirm',
  'order.reject',
  'order.cancel',
  'order.refund',
  // shop — listing / crowdfunding
  'listing.buy',
  'listing.talk', // open buyer↔seller DM (no state change)
  'crowdfunding.contribute',
  'crowdfunding.withdraw',
  // tasks
  'task.accept',
  'task.return',
  'task.take',
  // calendar
  'event.rsvp_accept',
  'event.rsvp_decline',
  'event.rsvp_tentative',
] as const;

export const RICH_CARD_LIMITS = {
  maxFields: 12,
  maxActions: 6,
} as const;
