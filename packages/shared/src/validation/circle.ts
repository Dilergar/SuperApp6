import { z } from 'zod';
import { cardVisibilityObjectSchema } from './card-visibility';
import { CONTACT_LIMITS } from '../constants/contacts';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет должен быть в формате #RRGGBB');
// Значок Группы: тот же формат, что у остальных сервисов (см. FIN/SHOP/WALLET_LIMITS).
const iconSchema = z.string().max(64);

export const createCircleSchema = z.object({
  name: z.string().min(1, 'Название группы обязательно').max(100),
  icon: iconSchema.optional(),
  color: hexColor.optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateCircleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  icon: iconSchema.nullable().optional(),
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  // Per-group card visibility (partial — merged over defaults on write).
  cardVisibility: cardVisibilityObjectSchema.nullable().optional(),
  // Per-group calendar access (Phase 2).
  calendarVisibility: z.enum(['none', 'busy', 'detailed']).optional(),
});

export const addToCircleSchema = z.object({
  contactLinkId: z.string().uuid(),
});

export const reorderCirclesSchema = z.object({
  circles: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1)
    // Потолок = лимит групп на владельца: без него один запрос собирал
    // транзакцию из произвольного числа UPDATE'ов.
    .max(CONTACT_LIMITS.maxCirclesPerUser)
    .refine(
      (list) => new Set(list.map((c) => c.id)).size === list.length,
      'Группа указана дважды'
    ),
});
