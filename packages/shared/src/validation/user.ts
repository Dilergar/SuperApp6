import { z } from 'zod';
import { cardVisibilityObjectSchema } from './card-visibility';

const noHtml = (s: string) => !/[<>]/.test(s);
const noHtmlMsg = 'Недопустимые символы';

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).refine(noHtml, noHtmlMsg).optional(),
  lastName: z.string().max(50).refine(noHtml, noHtmlMsg).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат: YYYY-MM-DD').nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  bio: z.string().max(160).refine(noHtml, noHtmlMsg).nullable().optional(),
  city: z.string().max(100).refine(noHtml, noHtmlMsg).nullable().optional(),
  email: z.string().email('Неверный формат email').nullable().optional(),
  maritalStatus: z.enum(['single', 'married', 'relationship', 'divorced', 'widowed']).nullable().optional(),
  socialLinks: z.object({
    telegram: z.string().max(100).optional(),
    instagram: z.string().max(100).optional(),
    linkedin: z.string().max(200).optional(),
    whatsapp: z.string().max(20).optional(),
  }).strict().nullable().optional(),
  onlineStatusMode: z.enum(['everyone', 'contacts', 'nobody']).optional(),
  locale: z.enum(['ru', 'kk', 'en']).optional(),
  timezone: z.string().max(50).optional(),
  // Owner's DEFAULT card visibility (single object) — applied to contacts
  // in none of the owner's groups. Per-group visibility is set via circles.
  cardVisibility: cardVisibilityObjectSchema.nullable().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
