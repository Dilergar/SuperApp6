import type { ListingItemType } from '../types/shop';

export const SHOP_LIMITS = {
  maxShowcases: 50,
  maxListingsPerShowcase: 500,
  maxNameLength: 80,
  maxTitleLength: 120,
  maxDescriptionLength: 2000,
  maxIconLength: 16,
  maxTaskDays: 365,
  maxPriceLines: 5, // cross-currency price: max distinct currencies in one listing's price (P5)
  maxWishItems: 200, // max items in a user's wishlist (P8)
} as const;

export const LISTING_ITEM_TYPE_LABELS: Record<ListingItemType, string> = {
  material: 'Материальный',
  nonmaterial: 'Нематериальный',
};
