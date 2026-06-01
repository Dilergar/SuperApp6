import {
  RICH_CARD_REF_TYPES,
  RICH_CARD_ACTION_STYLES,
  RICH_CARD_ACTION_KEYS,
} from '../constants/rich-card';

export type RichCardRefType = (typeof RICH_CARD_REF_TYPES)[number];
export type RichCardActionStyle = (typeof RICH_CARD_ACTION_STYLES)[number];
export type RichCardActionKey = (typeof RICH_CARD_ACTION_KEYS)[number];

/** A key/value line shown in the card body. */
export interface RichCardField {
  label: string;
  value: string;
}

/** Optional progress bar (e.g. crowdfunding goal). 0..1 fraction OR explicit current/target. */
export interface RichCardProgress {
  current: number;
  target: number;
  /** Pre-rendered label, e.g. "120 / 200 🪙". */
  label?: string;
}

/** A button. Clicking POSTs {actionKey, ref, payload?} to /rich-cards/:actionKey/execute. */
export interface RichCardAction {
  key: RichCardActionKey;
  label: string;
  style?: RichCardActionStyle;
  /** Optional structured input the action needs (e.g. contribution lines). */
  payload?: Record<string, unknown>;
}

/**
 * The rendered card stored in Message.payload (Message.type='rich_card'). The renderer
 * rebuilds `fields`/`actions`/`status` from LIVE data on each read, so the card reflects
 * current state and stale buttons disappear. `ref` is the durable anchor.
 */
export interface RichCardPayload {
  /** Marks a Message.payload as a rich card. */
  kind: 'rich_card';
  cardType: RichCardRefType;
  ref: { type: RichCardRefType; id: string };
  title: string;
  subtitle?: string | null;
  icon?: string | null;
  imageUrl?: string | null;
  fields: RichCardField[];
  progress?: RichCardProgress | null;
  /** Short status word, e.g. "Ожидает подтверждения". */
  status?: string | null;
  /** Action buttons available to the CURRENT viewer (already permission-filtered). */
  actions: RichCardAction[];
  /** Deep link into the owning service (e.g. /shop, /tasks/<id>). */
  href?: string | null;
}

// ---- request payloads ----
export interface ExecuteRichCardActionRequest {
  ref: { type: RichCardRefType; id: string };
  payload?: Record<string, unknown>;
}

/** Result of executing an action: the freshly re-rendered card for the actor. */
export interface ExecuteRichCardActionResult {
  card: RichCardPayload;
  /** Optional human note to surface (e.g. "Заказ подтверждён"). */
  message?: string | null;
}

/** Request to share an entity's card into a chat (POST /rich-cards/share). */
export interface ShareRichCardRequest {
  chatId: string;
  refType: RichCardRefType;
  refId: string;
}
