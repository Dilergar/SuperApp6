import { z } from 'zod';
import { KEYS_LIMITS, WEBHOOK_LIMITS } from '../constants/keys';
import {
  API_KEY_REVOKE_REASONS,
  BOT_RANKS,
  KEY_REGISTRY_FILTERS,
  KEY_REGISTRY_KINDS,
  KEY_SCOPE_LEVELS,
  KEY_SCOPE_SERVICE_KEYS,
  SIGNING_AUDIENCES,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_SIGNINGS,
  type KeyScopeService,
  type WebhookEventKey,
} from '../keys';
import { isAllowlistCidr, isValidCidr } from '../utils/cidr';

// ============================================================
// core/keys + core/webhooks — входные схемы (единственное описание формы: тип = z.infer)
// ============================================================

const uuid = z.string().uuid();
const name = z.string().trim().min(1, 'validation.keys.nameRequired').max(KEYS_LIMITS.nameMaxLength, 'validation.keys.nameTooLong');
/** «Для чего» — обязательное поле: реестр обязан отвечать, зачем ключ существует. */
const purpose = z
  .string()
  .trim()
  .min(KEYS_LIMITS.purposeMinLength, 'validation.keys.purposeRequired')
  .max(KEYS_LIMITS.purposeMaxLength, 'validation.keys.purposeTooLong');
const storedHint = z.string().trim().max(KEYS_LIMITS.storedHintMaxLength, 'validation.keys.storedHintTooLong').optional();

export const keyScopeServiceSchema = z.enum(KEY_SCOPE_SERVICE_KEYS as [KeyScopeService, ...KeyScopeService[]]);
export const keyScopeLevelSchema = z.enum(KEY_SCOPE_LEVELS);
/** `{ tasks: 'write', documents: 'read' }` — сервисы вне реестра отвергаются. */
export const keyScopesSchema = z.record(keyScopeServiceSchema, keyScopeLevelSchema);

export const ipAllowlistSchema = z
  .array(z.string().trim().min(1).max(64).refine(isValidCidr, 'validation.keys.badCidr').refine(isAllowlistCidr, 'validation.keys.cidrTooWide'))
  .max(KEYS_LIMITS.ipAllowlistMax, 'validation.keys.allowlistTooLong');

/** Срок ключа: дни либо явное «бессрочно» (только owner и только с IP-списком — проверяет сервер). */
const expiryShape = {
  expiresInDays: z.number().int().min(1).max(KEYS_LIMITS.patMaxDays * 10).optional(),
  noExpiry: z.boolean().optional(),
};
const expiryConsistent = (v: { noExpiry?: boolean; expiresInDays?: number }): boolean => !(v.noExpiry && v.expiresInDays);
const EXPIRY_CONFLICT = { path: ['noExpiry'], message: 'validation.keys.expiryConflict' };

export const botCreateSchema = z
  .object({
    name,
    glyph: z.string().trim().max(64).optional(),
    purpose,
    rank: z.enum(BOT_RANKS).default('member'),
    responsibleUserId: uuid.optional(),
    scopes: keyScopesSchema,
    ipAllowlist: ipAllowlistSchema.default([]),
    storedHint,
    ...expiryShape,
  })
  .strict()
  .refine(expiryConsistent, EXPIRY_CONFLICT);
export type BotCreateInput = z.infer<typeof botCreateSchema>;

export const botUpdateSchema = z
  .object({
    name: name.optional(),
    glyph: z.string().trim().max(64).nullable().optional(),
    purpose: purpose.optional(),
    rank: z.enum(BOT_RANKS).optional(),
    responsibleUserId: uuid.nullable().optional(),
    scopes: keyScopesSchema.optional(),
    ipAllowlist: ipAllowlistSchema.optional(),
  })
  .strict();
export type BotUpdateInput = z.infer<typeof botUpdateSchema>;

/** Личный ключ (PAT) — для собственных данных (`/keys/personal`) или данных организации (`/workspaces/:id/keys/keys`). */
export const apiKeyCreateSchema = z
  .object({
    name,
    purpose,
    scopes: keyScopesSchema,
    ipAllowlist: ipAllowlistSchema.default([]),
    storedHint,
    ...expiryShape,
  })
  .strict()
  .refine(expiryConsistent, EXPIRY_CONFLICT);
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;

/** Новый ключ бота (второй в семействе / после отзыва). */
export const botKeyCreateSchema = z
  .object({ name: name.optional(), purpose: purpose.optional(), storedHint, ...expiryShape })
  .strict()
  .refine(expiryConsistent, EXPIRY_CONFLICT);
export type BotKeyCreateInput = z.infer<typeof botKeyCreateSchema>;

/** Ротация: окно grace старого секрета (0 — сразу). */
export const apiKeyRotateSchema = z
  .object({
    graceHours: z.number().int().min(0).max(KEYS_LIMITS.graceMaxDays * 24).default(24),
    storedHint,
  })
  .strict();
export type ApiKeyRotateInput = z.infer<typeof apiKeyRotateSchema>;

export const apiKeyRevokeSchema = z
  .object({ reason: z.enum(API_KEY_REVOKE_REASONS).optional(), note: z.string().trim().max(300).optional() })
  .strict();
export type ApiKeyRevokeInput = z.infer<typeof apiKeyRevokeSchema>;

export const apiKeyUpdateSchema = z
  .object({ name: name.optional(), storedHint, ipAllowlist: ipAllowlistSchema.optional() })
  .strict();
export type ApiKeyUpdateInput = z.infer<typeof apiKeyUpdateSchema>;

export const keyRegistryQuerySchema = z
  .object({
    kind: z.enum(KEY_REGISTRY_KINDS).optional(),
    filter: z.enum(KEY_REGISTRY_FILTERS).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(KEYS_LIMITS.registryPageSize).optional(),
  })
  .strict();
export type KeyRegistryQuery = z.infer<typeof keyRegistryQuerySchema>;

export const keyJournalQuerySchema = z
  .object({
    subjectType: z.enum(['bot', 'api_key', 'webhook_endpoint']).optional(),
    subjectId: uuid.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(KEYS_LIMITS.journalPageSize).optional(),
  })
  .strict();
export type KeyJournalQuery = z.infer<typeof keyJournalQuerySchema>;

export const keyPolicyUpdateSchema = z
  .object({
    maxPatDays: z.number().int().min(1).max(KEYS_LIMITS.patMaxDays).optional(),
    maxBotKeyDays: z.number().int().min(1).max(KEYS_LIMITS.patMaxDays * 10).nullable().optional(),
    requireIpAllowlist: z.boolean().optional(),
  })
  .strict();
export type KeyPolicyUpdateInput = z.infer<typeof keyPolicyUpdateSchema>;

/** Разморозка бота — только owner, со step-up. */
export const botUnfreezeSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
export type BotUnfreezeInput = z.infer<typeof botUnfreezeSchema>;

/** Сигнал сканера секретов (формат GitHub secret scanning partner program). */
export const keysLeakedSchema = z
  .array(
    z
      .object({
        token: z.string().min(16).max(256),
        type: z.string().max(64).optional(),
        url: z.string().max(2048).optional(),
        source: z.string().max(64).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100);
export type KeysLeakedInput = z.infer<typeof keysLeakedSchema>;

export const apiKeyVerifySchema = z.object({ key: z.string().min(16).max(256) }).strict();
export type ApiKeyVerifyInput = z.infer<typeof apiKeyVerifySchema>;

// ---- Исходящие вебхуки ----

const webhookUrl = z
  .string()
  .trim()
  .url('validation.keys.webhookUrl')
  .max(2048)
  // Только https; http допускается ТОЛЬКО на loopback (dev-полигон сьюта, сервер сверх того требует WEBHOOKS_DEV_LOOPBACK)
  .refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u), 'validation.keys.webhookHttpsOnly');

export const webhookEventKeySchema = z.enum(WEBHOOK_EVENT_KEYS as [WebhookEventKey, ...WebhookEventKey[]]);

export const webhookEndpointCreateSchema = z
  .object({
    url: webhookUrl,
    events: z.array(webhookEventKeySchema).min(1).max(WEBHOOK_LIMITS.maxEventsPerEndpoint),
    signing: z.enum(WEBHOOK_SIGNINGS).default('hmac'),
  })
  .strict();
export type WebhookEndpointCreateInput = z.infer<typeof webhookEndpointCreateSchema>;

export const webhookEndpointUpdateSchema = z
  .object({
    events: z.array(webhookEventKeySchema).min(1).max(WEBHOOK_LIMITS.maxEventsPerEndpoint).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type WebhookEndpointUpdateInput = z.infer<typeof webhookEndpointUpdateSchema>;

export const webhookRotateSecretSchema = z
  .object({ prevHours: z.number().int().min(0).max(WEBHOOK_LIMITS.prevSecretHours).default(WEBHOOK_LIMITS.prevSecretHours) })
  .strict();
export type WebhookRotateSecretInput = z.infer<typeof webhookRotateSecretSchema>;

export const webhookDeliveriesQuerySchema = z
  .object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();
export type WebhookDeliveriesQuery = z.infer<typeof webhookDeliveriesQuerySchema>;

// ---- Команды кабинета платформы ----

export const keysRootRotateInputSchema = z
  .object({
    /**
     * Отпечаток НОВОГО корня (16 hex — его печатает церемония `keys-init-root.cjs`). Сам файл
     * заранее выкладывается на КАЖДЫЙ инстанс как `KEYS_ROOT_KEY_FILE_NEXT`; команда сверяет
     * отпечаток, перекличку инстансов и ставит фоновую перешивку порциями.
     */
    newRootKid: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();
export type KeysRootRotateInput = z.infer<typeof keysRootRotateInputSchema>;

/** Смена ключа слепых индексов (только при компрометации): входа нет — ключ один на платформу. */
export const keysBlindIndexRotateInputSchema = z.object({}).strict();
export type KeysBlindIndexRotateInput = z.infer<typeof keysBlindIndexRotateInputSchema>;

export const keysSigningRotateInputSchema = z.object({ audience: z.enum(SIGNING_AUDIENCES) }).strict();
export type KeysSigningRotateInput = z.infer<typeof keysSigningRotateInputSchema>;

export const keysWorkspaceFreezeInputSchema = z.object({ workspaceId: uuid }).strict();
export type KeysWorkspaceFreezeInput = z.infer<typeof keysWorkspaceFreezeInputSchema>;

export const keysKeyRevokeInputSchema = z.object({ keyId: uuid }).strict();
export type KeysKeyRevokeInput = z.infer<typeof keysKeyRevokeInputSchema>;

export const keysBotFreezeInputSchema = z.object({ botId: uuid }).strict();
export type KeysBotFreezeInput = z.infer<typeof keysBotFreezeInputSchema>;
