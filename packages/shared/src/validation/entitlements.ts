import { z } from 'zod';
import {
  ENTITLEMENT_GRANT_SOURCES,
  ENTITLEMENT_KEYS,
  ENTITLEMENT_OVERRIDE_MODES,
  ENTITLEMENT_REGISTRY,
  ENTITLEMENT_SUBJECT_TYPES,
  PLAN_KEYS,
  SUBSCRIPTION_STATUSES,
  isValidEntitlementValue,
  type EntitlementKey,
} from '../entitlements';

// ============================================================
// core/entitlements — Zod: вход ручек продукта и команд кабинета
// ============================================================

export const entitlementKeySchema = z.enum(ENTITLEMENT_KEYS as [EntitlementKey, ...EntitlementKey[]]);
export const entitlementSubjectTypeSchema = z.enum(ENTITLEMENT_SUBJECT_TYPES);
export const planKeySchema = z.enum(PLAN_KEYS);

export const entitlementSubjectSchema = z
  .object({
    type: entitlementSubjectTypeSchema,
    id: z.string().uuid(),
  })
  .strict();
export type EntitlementSubjectInput = z.infer<typeof entitlementSubjectSchema>;

/** Значение ключа: boolean у feature, целое ≥ 0 либо null у остальных. Проверяется вместе с ключом. */
const entitlementValueSchema = z.union([z.number(), z.boolean(), z.null()]);

/**
 * JSON значений версии плана: только ключи реестра, значения по виду ключа,
 * размер ограничен — кривой JSON не должен валить резолвер (S15).
 */
export const planEntitlementsJsonSchema = z
  .record(z.string().max(80), entitlementValueSchema)
  .superRefine((obj, ctx) => {
    const entries = Object.entries(obj);
    if (entries.length > 200) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.tooManyKeys' });
      return;
    }
    for (const [key, value] of entries) {
      const def = (ENTITLEMENT_REGISTRY as Record<string, (typeof ENTITLEMENT_REGISTRY)[EntitlementKey]>)[key];
      if (!def) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.unknownKey', path: [key] });
        continue;
      }
      if (!isValidEntitlementValue(def, value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.badValue', path: [key] });
      }
    }
  });

/** POST /entitlements/check — батч ключей в контексте запроса. */
export const entitlementCheckSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            key: entitlementKeySchema,
            delta: z.number().int().min(0).max(1_000_000_000_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type EntitlementCheckInput = z.infer<typeof entitlementCheckSchema>;

// ---- Команды кабинета (входы объявляют команды реестра core/platform) ----

const reason = z.string().trim().min(10).max(1000);
const isoDate = z.string().datetime();

export const planCreateVersionInputSchema = z
  .object({
    planKey: planKeySchema,
    /** Откуда взять значения: последняя версия плана (по умолчанию) либо свой JSON */
    entitlements: planEntitlementsJsonSchema.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type PlanCreateVersionInput = z.infer<typeof planCreateVersionInputSchema>;

export const planUpdateDraftInputSchema = z
  .object({
    planVersionId: z.string().uuid(),
    entitlements: planEntitlementsJsonSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type PlanUpdateDraftInput = z.infer<typeof planUpdateDraftInputSchema>;

export const planVersionRefInputSchema = z.object({ planVersionId: z.string().uuid() }).strict();
export type PlanVersionRefInput = z.infer<typeof planVersionRefInputSchema>;

export const subscriptionSetInputSchema = z
  .object({
    subject: entitlementSubjectSchema,
    /** Версия плана (опубликованная) либо ключ плана → последняя опубликованная версия; null = снять подписку (free) */
    planVersionId: z.string().uuid().nullable().optional(),
    planKey: planKeySchema.optional(),
    status: z.enum(SUBSCRIPTION_STATUSES).optional(),
    currentPeriodEnd: isoDate.nullable().optional(),
    trialEndsAt: isoDate.nullable().optional(),
  })
  .strict();
export type SubscriptionSetInput = z.infer<typeof subscriptionSetInputSchema>;

export const trialExtendInputSchema = z
  .object({
    subject: entitlementSubjectSchema,
    /** Новая дата окончания пробного периода (позже текущей) */
    trialEndsAt: isoDate,
  })
  .strict();
export type TrialExtendInput = z.infer<typeof trialExtendInputSchema>;

export const grantCreateInputSchema = z
  .object({
    subject: entitlementSubjectSchema,
    key: entitlementKeySchema,
    value: entitlementValueSchema,
    source: z.enum(ENTITLEMENT_GRANT_SOURCES),
    priority: z.number().int().min(0).max(1000).optional(),
    effectiveFrom: isoDate.optional(),
    /**
     * Срок обязателен, как у индивидуального условия: бессрочная привилегия, выданная
     * рукой сотрудника, иначе накапливается молча и живёт дольше причины, по которой
     * её выдали. Продление — новый грант с новым сроком.
     */
    validUntil: isoDate,
    reason: reason.optional(),
    idempotencyKey: z.string().trim().min(4).max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!isValidEntitlementValue(ENTITLEMENT_REGISTRY[v.key], v.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.badValue', path: ['value'] });
    }
    if (new Date(v.validUntil).getTime() <= Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.untilInPast', path: ['validUntil'] });
    }
  });
export type GrantCreateInput = z.infer<typeof grantCreateInputSchema>;

export const grantRevokeInputSchema = z.object({ grantId: z.string().uuid() }).strict();
export type GrantRevokeInput = z.infer<typeof grantRevokeInputSchema>;

export const overrideSetInputSchema = z
  .object({
    subject: entitlementSubjectSchema,
    key: entitlementKeySchema,
    mode: z.enum(ENTITLEMENT_OVERRIDE_MODES),
    value: entitlementValueSchema.optional(),
    /** Причина обязательна (индивидуальное условие — всегда с объяснением) */
    reason,
    /** Срок обязателен: бессрочных индивидуальных условий нет */
    validUntil: isoDate,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'set') {
      if (v.value === undefined || !isValidEntitlementValue(ENTITLEMENT_REGISTRY[v.key], v.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.badValue', path: ['value'] });
      }
    }
    if (new Date(v.validUntil).getTime() <= Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.entitlements.untilInPast', path: ['validUntil'] });
    }
  });
export type OverrideSetInput = z.infer<typeof overrideSetInputSchema>;

export const overrideClearInputSchema = z
  .object({ subject: entitlementSubjectSchema, key: entitlementKeySchema })
  .strict();
export type OverrideClearInput = z.infer<typeof overrideClearInputSchema>;
