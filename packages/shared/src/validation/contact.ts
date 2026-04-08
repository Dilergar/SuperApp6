import { z } from 'zod';
import { phoneSchema } from './auth';

export const relationshipTypeSchema = z.enum([
  'family',
  'romantic',
  'friend',
  'professional',
  'acquaintance',
  'other',
]);

const labelSchema = z
  .string()
  .min(1, 'Метка не может быть пустой')
  .max(50, 'Метка слишком длинная');

const messageSchema = z
  .string()
  .max(500, 'Сообщение слишком длинное');

// ============================================================
// Invitations
// ============================================================

export const sendInvitationSchema = z.object({
  toPhone: phoneSchema,
  relationshipType: relationshipTypeSchema,
  proposedLabelForRecipient: labelSchema.optional(),
  proposedLabelForSender: labelSchema.optional(),
  message: messageSchema.optional(),
  autoAddToCircleIds: z.array(z.string().uuid()).max(20).optional(),
});

export const acceptInvitationSchema = z.object({
  myLabelForThem: labelSchema.optional(),
  theirLabelForMe: labelSchema.optional(),
  relationshipType: relationshipTypeSchema.optional(),
  autoAddToCircleIds: z.array(z.string().uuid()).max(20).optional(),
});

export const updateContactSchema = z.object({
  myLabelForThem: labelSchema.nullable().optional(),
  relationshipType: relationshipTypeSchema.optional(),
});

export const blockUserSchema = z.object({
  userId: z.string().uuid(),
});
