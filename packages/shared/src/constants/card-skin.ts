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
  common: { label: 'Обычный', color: '#8a8478', priceHint: 0 },
  uncommon: { label: 'Необычный', color: '#74a277', priceHint: 150 },
  rare: { label: 'Редкий', color: '#588cd3', priceHint: 400 },
  epic: { label: 'Эпический', color: '#8a6fae', priceHint: 900 },
  legendary: { label: 'Легендарный', color: '#d6a04c', priceHint: 1900 },
  mythic: { label: 'Мифический', color: '#de6d68', priceHint: 4000 },
};

export const SKIN_RARITIES: SkinRarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
];
