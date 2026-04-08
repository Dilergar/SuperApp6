import { z } from 'zod';

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().max(50).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат: YYYY-MM-DD').nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  bio: z.string().max(160).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  email: z.string().email('Неверный формат email').nullable().optional(),
  maritalStatus: z.enum(['single', 'married', 'relationship', 'divorced', 'widowed']).nullable().optional(),
  socialLinks: z.object({
    telegram: z.string().max(100).optional(),
    instagram: z.string().max(100).optional(),
    linkedin: z.string().max(200).optional(),
    whatsapp: z.string().max(20).optional(),
  }).nullable().optional(),
  onlineStatusMode: z.enum(['everyone', 'contacts', 'nobody']).optional(),
  locale: z.enum(['ru', 'kk', 'en']).optional(),
  timezone: z.string().max(50).optional(),
  cardVisibility: z.object({
    dateOfBirth: z.boolean().optional(),
    age: z.boolean().optional(),
    onlineStatus: z.boolean().optional(),
    maritalStatus: z.boolean().optional(),
    city: z.boolean().optional(),
    bio: z.boolean().optional(),
    email: z.boolean().optional(),
    socialLinks: z.boolean().optional(),
  }).nullable().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
