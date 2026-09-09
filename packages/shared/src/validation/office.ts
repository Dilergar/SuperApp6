import { z } from 'zod';
import { OFFICE_LIMITS } from '../constants/office';

// ============================================
// Виртуальный офис — Zod-схемы
// ============================================

const roomNameSchema = z
  .string()
  .trim()
  .min(1, 'validation.office.nameRequired')
  .max(OFFICE_LIMITS.maxNameLen)
  .refine((v) => !/[<>]/.test(v), 'validation.office.badCharacters');

/** POST /workspaces/:id/office/rooms — создать встречу (имя опционально) */
export const createOfficeRoomSchema = z
  .object({
    name: roomNameSchema.optional(),
  })
  .strict();

/** POST /workspaces/:id/office/rooms/:roomId/invite */
export const inviteOfficeRoomSchema = z
  .object({
    userIds: z.array(z.string().uuid()).min(1).max(OFFICE_LIMITS.maxInviteBatch),
  })
  .strict();

export type CreateOfficeRoomInput = z.infer<typeof createOfficeRoomSchema>;
export type InviteOfficeRoomInput = z.infer<typeof inviteOfficeRoomSchema>;
