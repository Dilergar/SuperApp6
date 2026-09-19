import { z } from 'zod';
import { consentSelectionSchema } from './consents';
import { SUPPORTED_LOCALES } from '../constants/i18n';
import { phoneSchema } from './auth';

const noHtml = (s: string) => !/[<>]/.test(s);

// Roles assignable via role-change. NOTE: "owner" excluded (only via transfer),
// "contractor" excluded (granted programmatically by services, never by hand).
// Who may assign what (owner-only admin grant) is enforced in the service layer.
const ASSIGNABLE_WORKSPACE_ROLES = ['admin', 'manager', 'staff', 'trainee'] as const;

const nameSchema = z
  .string()
  .min(1, 'validation.workspace.nameRequired')
  .max(100)
  .refine(noHtml, 'validation.workspace.badCharacters');

const logoSchema = z.string().max(500).refine(noHtml, 'validation.workspace.badCharacters');

const messageSchema = z.string().max(500).refine(noHtml, 'validation.workspace.badCharacters');

const assignableRoleSchema = z.enum(ASSIGNABLE_WORKSPACE_ROLES);

// ============================================================
// Workspace CRUD
// ============================================================

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  logo: logoSchema.optional(),
  // Пакет `workspace_creation` (Условия для организаций + Соглашение об обработке ПДн): одна
  // галочка владельца. В production обязателен; запись приёмки — в транзакции создания.
  consents: consentSelectionSchema.optional(),
});

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    logo: logoSchema.nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'validation.workspace.nothingToUpdate');

export const transferOwnershipSchema = z.object({
  toUserId: z.string().uuid(),
});

// ============================================================
// Company profile (Анкета) — mirrors updateProfileSchema for the org card
// ============================================================

const descriptionSchema = z.string().max(1000).refine(noHtml, 'validation.workspace.badCharacters');
const industrySchema = z.string().max(100).refine(noHtml, 'validation.workspace.badCharacters');
const cityOrgSchema = z.string().max(100).refine(noHtml, 'validation.workspace.badCharacters');
const websiteSchema = z.string().max(200).refine(noHtml, 'validation.workspace.badCharacters');
const contactEmailSchema = z.string().email().max(200);
const contactPhoneSchema = z.string().max(20).refine(noHtml, 'validation.workspace.badCharacters');

// Default-visibility flags (what members see). Partial: UI may send a subset.
export const workspaceCardVisibilitySchema = z
  .object({
    description: z.boolean(),
    industry: z.boolean(),
    city: z.boolean(),
    website: z.boolean(),
    contactEmail: z.boolean(),
    contactPhone: z.boolean(),
    membersCount: z.boolean(),
    requisites: z.boolean(),
    extras: z.record(z.boolean()).optional(),
  })
  .partial();

export const updateWorkspaceProfileSchema = z
  .object({
    name: nameSchema.optional(),
    logo: logoSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    industry: industrySchema.nullable().optional(),
    city: cityOrgSchema.nullable().optional(),
    website: websiteSchema.nullable().optional(),
    contactEmail: contactEmailSchema.nullable().optional(),
    contactPhone: contactPhoneSchema.nullable().optional(),
    cardVisibility: workspaceCardVisibilitySchema.optional(),
    /**
     * ЯЗЫК ДОКУМЕНТОВ организации — язык её бумаг (договоры, приказы, счета), а
     * не интерфейса. Умолчание для новых бланков; у отдельного бланка свой.
     */
    documentLanguage: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'validation.workspace.nothingToUpdate');

// ============================================================
// Members & invitations
// ============================================================

// Найм всегда в Стажёра — роли в схеме НЕТ. Должность + филиалы — опционально из
// справочников (несколько филиалов: при принятии создаётся назначение на каждый).
export const inviteWorkspaceMemberSchema = z.object({
  phone: phoneSchema,
  positionId: z.string().uuid().optional(),
  branchIds: z.array(z.string().uuid()).max(50).optional(),
  message: messageSchema.optional(),
});

// Смена роли — единственное, что меняется у члена напрямую
// (должности — через назначения StaffModule).
export const updateWorkspaceMemberSchema = z.object({
  role: assignableRoleSchema,
});

// ---- Входные типы: ЕДИНСТВЕННОЕ описание формы входа ----
// Рукописные интерфейсы в types/*.ts удалены: два независимых описания одного
// входа расходятся молча (Zod уходил вперёд, интерфейс врал).
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
export type InviteWorkspaceMemberInput = z.infer<typeof inviteWorkspaceMemberSchema>;
export type UpdateWorkspaceMemberInput = z.infer<typeof updateWorkspaceMemberSchema>;
