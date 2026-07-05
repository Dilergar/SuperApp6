// ============================================================
// MY WISH & SHOP — types (Phase 2: catalog skeleton)
// ============================================================
// A shop is 1-per-owner (user|workspace). Showcases ("Витрины") group listings and are shared
// per-showcase to people and/or Circle Groups (like calendar/card sharing). Buying is Phase 3.

export type ShopOwnerType = 'user' | 'workspace';
export type ListingItemType = 'material' | 'nonmaterial';
export type ListingStatus = 'active' | 'archived';
export type SharePrincipalType = 'user' | 'circle';
export type ShopStaffScope = 'shop' | 'showcase';

/** A shop as seen by a viewer (own or someone else's that's shared with them). */
export interface Shop {
  id: string;
  ownerType: ShopOwnerType;
  ownerId: string;
  /** Display name (falls back to the owner's name when unset). */
  name: string;
  /** Viewer is the owner. */
  isOwner: boolean;
  /** Viewer may manage (owner / shop or showcase staff / workspace owner-admin). */
  canManage: boolean;
  showcaseCount: number;
}

/** A resolved price line (listing or order): `amount` of a named currency (Phase 5: ≥1 lines). */
export interface ListingPriceDto {
  currencyId: string;
  currencyName: string;
  currencyIcon: string;
  scale: number;
  amount: number;
}

/** One requested price line when creating/updating a listing (Phase 5 cross-currency). */
export interface ListingPriceInput {
  currencyId: string;
  amount: number;
}

/** A currency the viewer may price a listing in: their own + currencies issued by their окружение. */
export interface AccessibleCurrencyDto {
  id: string;
  name: string;
  icon: string;
  scale: number;
  /** The user who issues this currency. */
  issuerId: string;
  /** Display name of the issuer (the owner sees whose coin it is). */
  issuerName: string;
  /** True for the viewer's own currency (shown first, the default price line). */
  isOwn: boolean;
}

export interface Listing {
  id: string;
  showcaseId: string;
  title: string;
  description: string | null;
  icon: string | null;
  itemType: ListingItemType;
  withTask: boolean;
  taskDays: number | null;
  crowdfunding: boolean;
  stockLimit: number | null;
  stockSold: number;
  availableFrom: string | null;
  availableUntil: string | null;
  discountPercent: number | null;
  discountUntil: string | null;
  status: ListingStatus;
  prices: ListingPriceDto[];
  /** Active crowdfunding campaign (Phase 6) — present only for a crowdfunding listing with a live campaign. */
  campaign?: ListingCampaignDto | null;
  /**
   * Обложка = первое фото галереи (движок файлов, публичный класс, thumb-вариант
   * если готов). null → карточка показывает emoji-icon (фолбэк).
   */
  coverUrl?: string | null;
  createdAt: string;
}

/** A listing's live crowdfunding campaign (Phase 6) — drives the progress bars on the card. */
export interface ListingCampaignDto {
  orderId: string;
  status: OrderStatus;
  /** Raised so far per currency (goal = the listing's `prices`). */
  raised: ContributionLine[];
  /** The viewer's own pledge per currency (empty if they haven't pledged). */
  myContribution: ContributionLine[];
}

/** One audience entry of a showcase (a person or a Group). Owner-only. */
export interface ShowcaseShareDto {
  principalType: SharePrincipalType;
  principalId: string;
  /** Resolved display name (person's full name or Group name). */
  name: string;
}

export interface Showcase {
  id: string;
  shopId: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  listingCount: number;
  /** The audience — only returned to the owner/managers (who edits sharing). */
  shares?: ShowcaseShareDto[];
}

export interface ShopStaffDto {
  userId: string;
  name: string;
  avatar: string | null;
  scope: ShopStaffScope;
  /** Set when scope = 'showcase'. */
  showcaseId?: string;
  showcaseName?: string;
}

/** A person/company whose shop is shared with the viewer (for the shop switcher). */
export interface AccessibleShopRef {
  shopId: string;
  ownerType: ShopOwnerType;
  ownerId: string;
  name: string;
  avatar: string | null;
}

// ---- Orders (Phase 3: purchase with escrow; Phase 5: cross-currency; Phase 6: crowdfunding) ----
// 'funding' = a crowdfunding campaign still collecting pledges (Phase 6).
export type OrderStatus = 'funding' | 'pending' | 'confirmed' | 'settled' | 'rejected' | 'cancelled' | 'refunded';

/** One pledge/raised line: `amount` of a currency. */
export interface ContributionLine {
  currencyId: string;
  amount: number;
}

/** A crowdfunding contributor (campaign detail view). */
export interface OrderContributorDto {
  userId: string;
  name: string;
  /** Sum of this contributor's pledged amounts across currencies (for the "top contributor" rank). */
  total: number;
}

export interface Order {
  id: string;
  listingId: string | null;
  /** Snapshotted listing title (survives listing deletion). */
  title: string;
  showcaseId: string;
  shopId: string;
  /** Single buyer; for a crowdfunding campaign = the initiator. */
  buyerId: string;
  /** Buyer's display name — set in the seller's "incoming orders" view. */
  buyerName?: string;
  sellerId: string;
  status: OrderStatus;
  /** Snapshotted price = the goal — one line per currency (cross-currency = multiple lines). */
  prices: ListingPriceDto[];
  itemType: ListingItemType;
  withTask: boolean;
  /** A joint-funded campaign (Phase 6). */
  crowdfunding: boolean;
  /** Crowdfunding only: total raised so far per currency (goal = `prices`). */
  raised?: ContributionLine[];
  /** Crowdfunding only: the viewer's own pledge per currency (empty if they haven't pledged). */
  myContribution?: ContributionLine[];
  /** Crowdfunding only, campaign-detail view: all contributors with their totals. */
  contributors?: OrderContributorDto[];
  /** Живое фото лота (обложка) — null, если лот удалён или фото нет (снапшота нет, v1). */
  listingCoverUrl?: string | null;
  createdAt: string;
}

// ---- Requests ----
export interface CreateShowcaseRequest {
  name: string;
  icon?: string | null;
}
export interface UpdateShowcaseRequest {
  name?: string;
  icon?: string | null;
  sortOrder?: number;
}
export interface ShareShowcaseRequest {
  principalType: SharePrincipalType;
  principalId: string;
}
export interface CreateListingRequest {
  showcaseId: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  itemType?: ListingItemType;
  withTask?: boolean;
  taskDays?: number | null;
  crowdfunding?: boolean;
  stockLimit?: number | null;
  availableFrom?: string | null;
  availableUntil?: string | null;
  discountPercent?: number | null;
  discountUntil?: string | null;
  /** Shorthand: a single price in the owner's own currency. Use `prices` for cross-currency. */
  priceAmount?: number;
  /** Cross-currency price (Phase 5): ≥1 lines, own + окружение currencies. Overrides priceAmount. */
  prices?: ListingPriceInput[];
}
export interface UpdateListingRequest {
  title?: string;
  description?: string | null;
  icon?: string | null;
  itemType?: ListingItemType;
  withTask?: boolean;
  taskDays?: number | null;
  crowdfunding?: boolean;
  stockLimit?: number | null;
  availableFrom?: string | null;
  availableUntil?: string | null;
  discountPercent?: number | null;
  discountUntil?: string | null;
  status?: ListingStatus;
  /** Shorthand: replace the price with a single line in the owner's own currency. */
  priceAmount?: number;
  /** Replace the whole price with these cross-currency lines (Phase 5). Overrides priceAmount. */
  prices?: ListingPriceInput[];
  sortOrder?: number;
}
export interface AssignShopStaffRequest {
  userId: string;
  scope: ShopStaffScope;
  showcaseId?: string;
}
/** Pledge toward a crowdfunding campaign (Phase 6): one line per currency, ≤ the remaining goal. */
export interface ContributeRequest {
  contributions: ContributionLine[];
}

// ---- Wishlist (Phase 8) ----
export type WishStatus = 'active' | 'fulfilled' | 'archived';

/** A wishlist item — a want. No price (a copier sets it). itemType is set by the wishlist owner. */
export interface WishItem {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  icon: string | null;
  /** A link the owner wants (optional). */
  link: string | null;
  itemType: ListingItemType;
  status: WishStatus;
  sortOrder: number;
  createdAt: string;
}

/** A person whose wishlist is shared with the viewer (for the wishlist switcher). */
export interface AccessibleWishlistRef {
  ownerId: string;
  name: string;
  avatar: string | null;
  itemCount: number;
}

export interface CreateWishRequest {
  title: string;
  description?: string | null;
  icon?: string | null;
  link?: string | null;
  itemType?: ListingItemType;
}
export interface UpdateWishRequest {
  title?: string;
  description?: string | null;
  icon?: string | null;
  link?: string | null;
  itemType?: ListingItemType;
  status?: WishStatus;
  sortOrder?: number;
}
/** Copy someone's wish into one of MY showcases as a priced lot (Phase 8). */
export interface CopyWishRequest {
  /** Put the lot into this existing showcase of mine, OR create a new one (newShowcaseName). */
  showcaseId?: string;
  newShowcaseName?: string;
  prices: ListingPriceInput[];
  crowdfunding?: boolean;
  stockLimit?: number | null;
  availableUntil?: string | null;
  discountPercent?: number | null;
  discountUntil?: string | null;
  taskDays?: number | null;
}
