import { z } from 'zod';
import { phoneSchema } from './auth';
import { verifyTokenSchema } from './verify';
import { PLATFORM_ENTITIES, PLATFORM_LIMITS, PLATFORM_ROLE_KEYS, type PlatformRoleKey } from '../platform';

// ============================================================
// core/platform — Zod кабинета: вход, команды, поиск, журнал, заявки
// ============================================================

// ---- Вход и сессия ----

export const platformAuthStartSchema = z
  .object({
    phone: phoneSchema,
    password: z.string().min(1).max(200),
  })
  .strict();
export type PlatformAuthStartInput = z.infer<typeof platformAuthStartSchema>;

export const platformLoginSchema = z.object({ verifyToken: verifyTokenSchema }).strict();
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;

export const platformStepUpStartSchema = z.object({ password: z.string().min(1).max(200) }).strict();
export type PlatformStepUpStartInput = z.infer<typeof platformStepUpStartSchema>;

export const platformStepUpConfirmSchema = z.object({ verifyToken: verifyTokenSchema }).strict();
export type PlatformStepUpConfirmInput = z.infer<typeof platformStepUpConfirmSchema>;

// ---- Исполнитель команд ----

export const platformIdempotencyKeySchema = z.string().trim().min(8).max(120);

export const platformCommandRunSchema = z
  .object({
    input: z.unknown().optional(),
    idempotencyKey: platformIdempotencyKeySchema,
    reason: z.string().trim().max(PLATFORM_LIMITS.reasonMaxLength).optional(),
    ticketRef: z.string().trim().max(120).optional(),
  })
  .strict();
export type PlatformCommandRunInput = z.infer<typeof platformCommandRunSchema>;

export const platformCommandPreviewSchema = z.object({ input: z.unknown().optional() }).strict();
export type PlatformCommandPreviewInput = z.infer<typeof platformCommandPreviewSchema>;

// ---- Поиск, карточка, PII ----

export const platformLookupQuerySchema = z.object({ q: z.string().max(200) }).strict();
export type PlatformLookupQuery = z.infer<typeof platformLookupQuerySchema>;

export const platformEntitySchema = z.enum(PLATFORM_ENTITIES);

export const platformPiiRevealInputSchema = z
  .object({
    entity: platformEntitySchema,
    id: z.string().uuid(),
    /** Какие поля раскрыть: телефон, ИИН, БИН, адрес, документ */
    fields: z.array(z.enum(['phone', 'iin', 'bin', 'residentialAddress', 'idDocNumber', 'email'])).min(1).max(6),
  })
  .strict();
export type PlatformPiiRevealInput = z.infer<typeof platformPiiRevealInputSchema>;

// ---- Журнал ----

export const platformAuditQuerySchema = z
  .object({
    actorId: z.string().uuid().optional(),
    targetType: z.string().max(40).optional(),
    targetId: z.string().max(64).optional(),
    commandKey: z.string().max(80).optional(),
    outcome: z.enum(['ok', 'denied', 'error']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type PlatformAuditQuery = z.infer<typeof platformAuditQuerySchema>;

// ---- Заявки four-eyes ----

export const platformRequestsQuerySchema = z
  .object({
    state: z.enum(['pending', 'mine', 'history']).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type PlatformRequestsQuery = z.infer<typeof platformRequestsQuerySchema>;

export const platformRequestDecideSchema = z
  .object({
    outcome: z.enum(['approved', 'rejected']),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();
export type PlatformRequestDecideInput = z.infer<typeof platformRequestDecideSchema>;

// ---- Входы команд самого кабинета ----

const roleKey = z.enum(PLATFORM_ROLE_KEYS as [PlatformRoleKey, ...PlatformRoleKey[]]);

export const platformStaffAddInputSchema = z
  .object({
    userId: z.string().uuid(),
    note: z.string().trim().max(500).optional(),
    /** Роль сразу при добавлении (иначе сотрудник без прав) */
    role: roleKey.optional(),
  })
  .strict();
export type PlatformStaffAddInput = z.infer<typeof platformStaffAddInputSchema>;

export const platformStaffSuspendInputSchema = z.object({ userId: z.string().uuid() }).strict();
export type PlatformStaffSuspendInput = z.infer<typeof platformStaffSuspendInputSchema>;

export const platformStaffRoleGrantInputSchema = z
  .object({
    userId: z.string().uuid(),
    role: roleKey,
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export type PlatformStaffRoleGrantInput = z.infer<typeof platformStaffRoleGrantInputSchema>;

export const platformStaffRoleRevokeInputSchema = z
  .object({ userId: z.string().uuid(), role: roleKey })
  .strict();
export type PlatformStaffRoleRevokeInput = z.infer<typeof platformStaffRoleRevokeInputSchema>;

export const platformPolicySetInputSchema = z.object({ dualControlEnabled: z.boolean() }).strict();
export type PlatformPolicySetInput = z.infer<typeof platformPolicySetInputSchema>;
