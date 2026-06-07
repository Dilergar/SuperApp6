// ============================================================
// Card Skins — shared types (API DTOs + render model)
//
// A skin is DATA: a set of visual tokens + optional layer assets
// (frame / background / Lottie effect). The PersonCard reads these
// to draw itself at any size. CardSkin = the design/type;
// CardSkinInstance = an owned copy ("real item" with a serial).
// ============================================================

export type SkinRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic';

/** Every color/border/shadow a skin can override on the card. */
export interface CardSkinTokens {
  cardBg: string;
  cardBorder: string;
  cardRadius: string;
  cardShadow: string;
  nameColor: string;
  nameFont: string;
  metaColor: string;
  avatarBg: string;
  avatarColor: string;
  avatarRing: string;
  avatarInnerBorder: string;
  avatarRadius: string;
  badgeBg: string;
  badgeColor: string;
  badgeShadow: string;
  accent: string;
  /** Built-in CSS effect preset (e.g. 'petals' | 'neonGlow' | 'sparkle'). Lottie effectUrl wins if set. */
  effectPreset?: string | null;
}

/** The minimum a card needs to render a skin. */
export interface CardSkinRender {
  id: string;
  name: string;
  rarity: SkinRarity;
  tokens: CardSkinTokens;
  frameUrl?: string | null;
  backgroundUrl?: string | null;
  effectUrl?: string | null;
  decor?: 'crayon' | 'none';
}

/** A shop catalog entry — render + commerce metadata. */
export interface CardSkinCatalogItem extends CardSkinRender {
  description: string | null;
  priceAmount: number;
  supply: number | null; // null = unlimited
  minted: number;
  remaining: number | null; // null = unlimited
  soldOut: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  available: boolean; // within window AND not sold out
  owned: boolean; // viewer already owns at least one copy
}

/** An owned copy of a skin. */
export interface CardSkinInstanceDto {
  id: string;
  skinId: string;
  serial: number | null; // only for limited skins
  acquiredVia: string;
  createdAt: string;
  skin: CardSkinRender & { description: string | null };
}

/** The platform-currency wallet used to buy skins. */
export interface CardSkinWallet {
  currencyId: string;
  name: string;
  icon: string;
  balance: number;
}

/** Current equip configuration for the owner. */
export interface CardSkinEquipState {
  defaultInstanceId: string | null;
  perGroup: { circleId: string; instanceId: string | null }[];
  premium: boolean;
}
