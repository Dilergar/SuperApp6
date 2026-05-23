import { z } from 'zod';

// Shared schema for a (partial) CardVisibility object. Reused by the
// profile default-visibility update and the per-group visibility update.
// `.strict()` rejects unknown fields.
export const cardVisibilityObjectSchema = z
  .object({
    dateOfBirth: z.boolean().optional(),
    age: z.boolean().optional(),
    onlineStatus: z.boolean().optional(),
    maritalStatus: z.boolean().optional(),
    city: z.boolean().optional(),
    bio: z.boolean().optional(),
    email: z.boolean().optional(),
    socialLinks: z.boolean().optional(),
    extras: z.record(z.boolean()).optional(),
  })
  .strict();
