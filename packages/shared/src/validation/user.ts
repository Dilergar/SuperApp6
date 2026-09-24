import { z } from 'zod';
import { userRequisiteFieldsSchema } from './requisites';
import { SUPPORTED_LOCALES } from '../constants/i18n';

const noHtml = (s: string) => !/[<>]/.test(s);
const noHtmlMsg = 'validation.user.badCharacters';

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).refine(noHtml, noHtmlMsg).optional(),
  lastName: z.string().max(50).refine(noHtml, noHtmlMsg).nullable().optional(),
  /** Отчество — реквизит документов (полное ФИО в приказах); в карточках не показывается */
  middleName: z.string().max(50).refine(noHtml, noHtmlMsg).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.user.isoDate').nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  bio: z.string().max(160).refine(noHtml, noHtmlMsg).nullable().optional(),
  city: z.string().max(100).refine(noHtml, noHtmlMsg).nullable().optional(),
  email: z.string().email('validation.user.email').nullable().optional(),
  maritalStatus: z.enum(['single', 'married', 'relationship', 'divorced', 'widowed']).nullable().optional(),
  socialLinks: z.object({
    telegram: z.string().max(100).optional(),
    instagram: z.string().max(100).optional(),
    linkedin: z.string().max(200).optional(),
    whatsapp: z.string().max(20).optional(),
  }).strict().nullable().optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  timezone: z.string().max(50).optional(),
  // Реквизиты для договоров и трудоустройства (блок «Моей Анкеты»):
  // ИИН с контрольной суммой, адрес проживания, удостоверение личности.
  ...userRequisiteFieldsSchema,
  // Видимость карточки и находимость — не поля анкеты: `/visibility/me` (core/visibility).
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
