import type { SkinRarity } from '../types/card-skin';

// The single platform-issued premium currency that buys skins.
// issuerType 'platform' is distinct from personal ('user') / company ('workspace').
export const PLATFORM_CURRENCY = {
  issuerType: 'platform',
  issuerId: 'platform',
  // Имя платформенной валюты — ДАННЫЕ (оно ложится в БД при сиде рядом с
  // валютами, которые заводят люди), поэтому пишется в языке ИСТОЧНИКА.
  name: 'Crystals',
  icon: '💎',
  scale: 0,
} as const;

// Canonical rarity ladder — a suggested price (guidance only; each skin sets its
// own price, higher tiers cost more — Overwatch-style ladder).
// ЦВЕТ кольца редкости здесь НЕ живёт: хекс не пересекает границу shared
// (DESIGN.md §1) — карта цветов у клиента (web: app/circles/card-skin.ts).
// СЛОВО тоже не живёт: имя ступени — `circles.rarity.<rarity>` в каталоге.
export const SKIN_RARITY_META: Record<SkinRarity, { priceHint: number }> = {
  common: { priceHint: 0 },
  uncommon: { priceHint: 150 },
  rare: { priceHint: 400 },
  epic: { priceHint: 900 },
  legendary: { priceHint: 1900 },
  mythic: { priceHint: 4000 },
};

export const SKIN_RARITIES: SkinRarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
];
