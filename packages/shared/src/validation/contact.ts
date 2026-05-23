import { z } from 'zod';
import { phoneSchema } from './auth';

const noHtml = (s: string) => !/[<>]/.test(s);

// One role per side. Free text, but presets are suggested in the UI
// (ROLE_PRESETS in constants/contacts).
const roleSchema = z
  .string()
  .min(1, 'Роль не может быть пустой')
  .max(50, 'Роль слишком длинная')
  .refine(noHtml, 'Недопустимые символы');

const messageSchema = z
  .string()
  .max(500, 'Сообщение слишком длинное')
  .refine(noHtml, 'Недопустимые символы');

// ============================================================
// Invitations
// ============================================================

export const sendInvitationSchema = z.object({
  toPhone: phoneSchema,
  proposedRoleForRecipient: roleSchema.optional(),
  proposedRoleForSender: roleSchema.optional(),
  message: messageSchema.optional(),
  autoAddToCircleIds: z.array(z.string().uuid()).max(20).optional(),
});

export const acceptInvitationSchema = z.object({
  myRole: roleSchema.optional(),
  theirRole: roleSchema.optional(),
  autoAddToCircleIds: z.array(z.string().uuid()).max(20).optional(),
});

export const updateContactSchema = z.object({
  myRole: roleSchema.nullable().optional(),
});

export const blockUserSchema = z.object({
  userId: z.string().uuid(),
});
