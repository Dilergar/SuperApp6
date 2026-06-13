import { z } from 'zod';
import { phoneSchema } from './auth';

const noHtml = (s: string) => !/[<>]/.test(s);

// Roles assignable via role-change. NOTE: "owner" excluded (only via transfer),
// "contractor" excluded (granted programmatically by services, never by hand).
// Who may assign what (owner-only admin grant) is enforced in the service layer.
const ASSIGNABLE_WORKSPACE_ROLES = ['admin', 'manager', 'staff', 'trainee'] as const;

const nameSchema = z
  .string()
  .min(1, 'Название не может быть пустым')
  .max(100, 'Название слишком длинное')
  .refine(noHtml, 'Недопустимые символы');

const logoSchema = z.string().max(500, 'Слишком длинная ссылка').refine(noHtml, 'Недопустимые символы');

const messageSchema = z
  .string()
  .max(500, 'Сообщение слишком длинное')
  .refine(noHtml, 'Недопустимые символы');

const assignableRoleSchema = z.enum(ASSIGNABLE_WORKSPACE_ROLES);

// ============================================================
// Workspace CRUD
// ============================================================

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  logo: logoSchema.optional(),
});

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    logo: logoSchema.nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

export const transferOwnershipSchema = z.object({
  toUserId: z.string().uuid(),
});

// ============================================================
// Company profile (Анкета) — mirrors updateProfileSchema for the org card
// ============================================================

const descriptionSchema = z
  .string()
  .max(1000, 'Описание слишком длинное')
  .refine(noHtml, 'Недопустимые символы');
const industrySchema = z
  .string()
  .max(100, 'Слишком длинно')
  .refine(noHtml, 'Недопустимые символы');
const cityOrgSchema = z
  .string()
  .max(100, 'Слишком длинно')
  .refine(noHtml, 'Недопустимые символы');
const websiteSchema = z
  .string()
  .max(200, 'Слишком длинная ссылка')
  .refine(noHtml, 'Недопустимые символы');
const contactEmailSchema = z.string().email('Некорректный email').max(200);
const contactPhoneSchema = z
  .string()
  .max(20, 'Слишком длинно')
  .refine(noHtml, 'Недопустимые символы');

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
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

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
