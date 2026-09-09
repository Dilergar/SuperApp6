import { z } from 'zod';
import { LEGAL_ENTITY_LIMITS } from '../constants/legal-entity';
import { workspaceRequisitesSchema } from './requisites';

const noHtml = (s: string) => !/[<>]/.test(s);

export const legalEntityNameSchema = z
  .string()
  .trim()
  .min(1, 'validation.legalEntity.nameRequired')
  .max(LEGAL_ENTITY_LIMITS.nameMaxLength)
  .refine(noHtml, 'validation.legalEntity.badCharacters');

/** POST /workspaces/:id/legal-entities — реквизиты + обязательное имя */
export const createLegalEntitySchema = workspaceRequisitesSchema
  .innerType()
  .extend({ name: legalEntityNameSchema })
  .strict();

/** PATCH /workspaces/:id/legal-entities/:leId */
export const updateLegalEntitySchema = workspaceRequisitesSchema
  .innerType()
  .extend({ name: legalEntityNameSchema.optional(), sortOrder: z.number().int().min(0).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'validation.legalEntity.nothingToUpdate');

export type CreateLegalEntityInput = z.infer<typeof createLegalEntitySchema>;
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntitySchema>;
