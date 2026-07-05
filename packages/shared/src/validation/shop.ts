import { z } from 'zod';
import { SHOP_LIMITS } from '../constants/shop';

const noAngle = (s: string) => !/[<>]/.test(s);
const text = (max: number) =>
  z.string().trim().min(1).max(max).refine(noAngle, { message: 'Недопустимые символы (< >)' });
const optText = (max: number) =>
  z.string().trim().max(max).refine(noAngle, { message: 'Недопустимые символы (< >)' }).nullable().optional();
const icon = z.string().trim().max(SHOP_LIMITS.maxIconLength).nullable().optional();

export const createShowcaseSchema = z
  .object({ name: text(SHOP_LIMITS.maxNameLength), icon })
  .strict();

export const updateShowcaseSchema = z
  .object({
    name: text(SHOP_LIMITS.maxNameLength).optional(),
    icon,
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

export const shareShowcaseSchema = z
  .object({
    principalType: z.enum(['user', 'circle']),
    principalId: z.string().uuid(),
  })
  .strict();

/** POST /shop/listings/:id/images — прикрепить фото (файл движка, профиль listing_image) */
export const attachListingImageSchema = z
  .object({
    fileId: z.string().uuid(),
  })
  .strict();

// One price line: `amount` of a currency (own or an окружение contact's). Phase 5 cross-currency.
const priceLine = z
  .object({
    currencyId: z.string().uuid(),
    amount: z.number().int().min(1),
  })
  .strict();

const pricesArray = z
  .array(priceLine)
  .min(1)
  .max(SHOP_LIMITS.maxPriceLines)
  .refine((lines) => new Set(lines.map((l) => l.currencyId)).size === lines.length, {
    message: 'Каждая валюта может быть указана только один раз',
  });

// Listing fields shared by create/update (title handled separately — required on create).
const listingCore = {
  description: optText(SHOP_LIMITS.maxDescriptionLength),
  icon,
  itemType: z.enum(['material', 'nonmaterial']).optional(),
  withTask: z.boolean().optional(),
  taskDays: z.number().int().min(1).max(SHOP_LIMITS.maxTaskDays).nullable().optional(),
  crowdfunding: z.boolean().optional(),
  stockLimit: z.number().int().min(1).nullable().optional(),
  availableFrom: z.string().datetime().nullable().optional(),
  availableUntil: z.string().datetime().nullable().optional(),
  discountPercent: z.number().int().min(1).max(99).nullable().optional(),
  discountUntil: z.string().datetime().nullable().optional(),
};

export const createListingSchema = z
  .object({
    showcaseId: z.string().uuid(),
    title: text(SHOP_LIMITS.maxTitleLength),
    priceAmount: z.number().int().min(1).optional(),
    prices: pricesArray.optional(),
    ...listingCore,
  })
  .strict()
  .refine((d) => d.priceAmount !== undefined || (d.prices && d.prices.length > 0), {
    message: 'Укажите цену (priceAmount или prices)',
  });

export const updateListingSchema = z
  .object({
    title: text(SHOP_LIMITS.maxTitleLength).optional(),
    priceAmount: z.number().int().min(1).optional(),
    prices: pricesArray.optional(),
    status: z.enum(['active', 'archived']).optional(),
    sortOrder: z.number().int().min(0).optional(),
    ...listingCore,
  })
  .strict();

// A crowdfunding pledge (Phase 6): ≥1 currency line, no dup currency, amounts ≥ 1.
export const contributeSchema = z
  .object({
    contributions: pricesArray,
  })
  .strict();

// ---- Wishlist (Phase 8) ----
const wishLink = z.string().trim().max(500).refine(noAngle, { message: 'Недопустимые символы (< >)' }).nullable().optional();

export const createWishSchema = z
  .object({
    title: text(SHOP_LIMITS.maxTitleLength),
    description: optText(SHOP_LIMITS.maxDescriptionLength),
    icon,
    link: wishLink,
    itemType: z.enum(['material', 'nonmaterial']).optional(),
  })
  .strict();

export const updateWishSchema = z
  .object({
    title: text(SHOP_LIMITS.maxTitleLength).optional(),
    description: optText(SHOP_LIMITS.maxDescriptionLength),
    icon,
    link: wishLink,
    itemType: z.enum(['material', 'nonmaterial']).optional(),
    status: z.enum(['active', 'fulfilled', 'archived']).optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

// Copy a wish into one of my showcases as a priced lot. Exactly one of showcaseId / newShowcaseName.
export const copyWishSchema = z
  .object({
    showcaseId: z.string().uuid().optional(),
    newShowcaseName: text(SHOP_LIMITS.maxNameLength).optional(),
    prices: pricesArray,
    crowdfunding: z.boolean().optional(),
    stockLimit: z.number().int().min(1).nullable().optional(),
    availableUntil: z.string().datetime().nullable().optional(),
    discountPercent: z.number().int().min(1).max(99).nullable().optional(),
    discountUntil: z.string().datetime().nullable().optional(),
    taskDays: z.number().int().min(1).max(SHOP_LIMITS.maxTaskDays).nullable().optional(),
  })
  .strict()
  .refine((d) => !!d.showcaseId !== !!d.newShowcaseName, {
    message: 'Укажите витрину или название новой (одно из двух)',
  });

export const assignShopStaffSchema = z
  .object({
    userId: z.string().uuid(),
    scope: z.enum(['shop', 'showcase']),
    showcaseId: z.string().uuid().optional(),
  })
  .strict()
  .refine((d) => d.scope !== 'showcase' || !!d.showcaseId, {
    message: 'showcaseId обязателен для роли витрины',
  });
