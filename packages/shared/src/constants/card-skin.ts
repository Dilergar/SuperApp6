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

// Canonical rarity ladder — label and a suggested price (guidance only;
// each skin sets its own price, higher tiers cost more — Overwatch-style ladder).
// ЦВЕТ кольца редкости здесь НЕ живёт: хекс не пересекает границу shared
// (DESIGN.md §1) — карта цветов у клиента (web: app/circles/card-skin.ts).
export const SKIN_RARITY_META: Record<
  SkinRarity,
  { label: string; priceHint: number }
> = {
  common: { label: 'Обычный', priceHint: 0 },
  uncommon: { label: 'Необычный', priceHint: 150 },
  rare: { label: 'Редкий', priceHint: 400 },
  epic: { label: 'Эпический', priceHint: 900 },
  legendary: { label: 'Легендарный', priceHint: 1900 },
  mythic: { label: 'Мифический', priceHint: 4000 },
};

export const SKIN_RARITIES: SkinRarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
];
