import type { SkinRarity } from '../types/card-skin';

// The single platform-issued premium currency that buys skins.
// issuerType 'platform' is distinct from personal ('user') / company ('workspace').
export const PLATFORM_CURRENCY = {
  issuerType: 'platform',
  issuerId: 'platform',
  name: 'Кристаллы',
  icon: '💎',
  scale: 0,
} as const;

// Canonical rarity ladder — label, ring color, and a suggested price (guidance only;
// each skin sets its own price, higher tiers cost more — Overwatch-style ladder).
export const SKIN_RARITY_META: Record<
  SkinRarity,
  { label: string; color: string; priceHint: number }
> = {
  common: { label: 'Обычный', color: '#9a958a', priceHint: 0 },
  uncommon: { label: 'Необычный', color: '#2d7a3a', priceHint: 150 },
  rare: { label: 'Редкий', color: '#326a8b', priceHint: 400 },
  epic: { label: 'Эпический', color: '#7a3a8b', priceHint: 900 },
  legendary: { label: 'Легендарный', color: '#b8860b', priceHint: 1900 },
  mythic: { label: 'Мифический', color: '#c61a1e', priceHint: 4000 },
};

export const SKIN_RARITIES: SkinRarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
];
