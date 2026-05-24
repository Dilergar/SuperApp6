import { z } from 'zod';
import { phoneSchema } from './auth';

const noHtml = (s: string) => !/[<>]/.test(s);

// Roles assignable via invite / role-change. NOTE: "owner" is intentionally excluded —
// ownership is set on creation and changed only via transfer (one owner per workspace).
const ASSIGNABLE_WORKSPACE_ROLES = ['admin', 'manager', 'staff', 'guest'] as const;

const nameSchema = z
  .string()
  .min(1, 'Название не может быть пустым')
  .max(100, 'Название слишком длинное')
  .refine(noHtml, 'Недопустимые символы');

const logoSchema = z.string().max(500, 'Слишком длинная ссылка').refine(noHtml, 'Недопустимые символы');

const positionSchema = z
  .string()
  .max(100, 'Должность слишком длинная')
  .refine(noHtml, 'Недопустимые символы');

const departmentSchema = z
  .string()
  .max(100, 'Отдел слишком длинный')
  .refine(noHtml, 'Недопустимые символы');

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

export const inviteWorkspaceMemberSchema = z.object({
  phone: phoneSchema,
  role: assignableRoleSchema.default('staff'),
  position: positionSchema.optional(),
  department: departmentSchema.optional(),
  message: messageSchema.optional(),
});

export const updateWorkspaceMemberSchema = z
  .object({
    role: assignableRoleSchema.optional(),
    position: positionSchema.nullable().optional(),
    department: departmentSchema.nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');
