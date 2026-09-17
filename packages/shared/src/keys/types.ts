// ============================================================
// core/keys (22-й платформенный движок) — словарь ключей, шифрования и подписи
// ============================================================
// Движок ключей — единственная дверь ко ВСЕЙ криптографии платформы: подпись
// токенов (Ed25519 + JWKS + `kid`), шифрование секретов и ПДн (envelope
// AES-256-GCM с AAD), слепые индексы (HMAC), ключи API организаций и людей,
// исходящие вебхуки. Здесь — общие для API и клиентов формы и перечисления;
// слова — в каталоге `@superapp/i18n` (неймспейс `keys`).

/** Провайдер корневого ключа: файл с правами 0600 (software) или HSM (pkcs11 — слот к проду). */
export const KEYS_PROVIDERS = ['software', 'pkcs11'] as const;
export type KeysProviderKind = (typeof KEYS_PROVIDERS)[number];

/** Назначение ключа — один ключ обслуживает ровно одно (OWASP KM, RFC 8725 §3.1). */
export const KEY_PURPOSES = ['kek', 'sign', 'mac'] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/**
 * Состояния версии ключа (модель Google Cloud KMS): `pending` — опубликована, но не
 * подписывает; `active` — рабочая; `disabled` — не шифрует и не подписывает, но
 * расшифровывает/проверяет; `destroy_scheduled` — материал уничтожится по сроку
 * (восстановимо → `disabled`); `destroyed` — материала нет, данные под ним нечитаемы.
 */
export const KEY_VERSION_STATES = ['pending', 'active', 'disabled', 'destroy_scheduled', 'destroyed'] as const;
export type KeyVersionState = (typeof KEY_VERSION_STATES)[number];

/** Скоуп ключа: платформа, организация или человек (KEK на каждого — взрывной радиус = один субъект). */
export const KEY_SCOPE_TYPES = ['platform', 'workspace', 'user'] as const;
export type KeyScopeType = (typeof KEY_SCOPE_TYPES)[number];

export type KeyScopeRef = { type: 'platform' } | { type: 'workspace' | 'user'; id: string };

/** Аудитории подписи — отдельная пара ключей на каждую (урок Storm-0558). */
export const SIGNING_AUDIENCES = ['product', 'platform', 'wopi', 'share_link', 'files_url', 'webhook'] as const;
export type SigningAudience = (typeof SIGNING_AUDIENCES)[number];

/** Именованные HMAC-ключи платформы. */
export const MAC_KEY_NAMES = ['blind_index', 'verify_otp', 'oauth_state', 'api_key_pepper'] as const;
export type MacKeyName = (typeof MAC_KEY_NAMES)[number];

/** Алгоритмы — метка в каждом артефакте (crypto-agility: смена = новая версия ключа). */
export const KEY_ALGORITHMS = {
  kek: 'A256GCM',
  sign: 'Ed25519',
  mac: 'HS256',
} as const;

/** Префиксы артефактов движка: по ним потребитель отличает новый формат от legacy. */
export const KEYS_ARTIFACT_PREFIX = {
  /** Шифротекст поля: `sa6e:1:<kek_kid>:<alg>:<wrappedDek>:<iv>:<ct+tag>` */
  envelope: 'sa6e',
  /** Слепой индекс: `sa6b:1:<mac_kid>:<hmac>` */
  blindIndex: 'sa6b',
  /** Именованный HMAC (код OTP, state OAuth): `sa6m:1:<mac_kid>:<hmac>` */
  mac: 'sa6m',
  /** Секрет API-ключа / вебхука: `sa6_<тип>_<среда>_<base62>_<crc>` */
  apiKey: 'sa6',
} as const;

/** Типы секретов в формате `sa6_<тип>_…`. */
export const API_KEY_KINDS = ['bot', 'pat', 'whs'] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

/** Среда в теле ключа (утечка `live`-ключа в тестовом коде видна с первого взгляда). */
export const API_KEY_ENVS = ['live', 'test'] as const;
export type ApiKeyEnv = (typeof API_KEY_ENVS)[number];

/** Режим чтения ПДн на окне dual-write (фаза миграции): читать старые колонки или зашифрованные. */
export const KEYS_PII_READ_MODES = ['legacy', 'encrypted'] as const;
export type KeysPiiReadMode = (typeof KEYS_PII_READ_MODES)[number];

/** Уровень скоупа: write ⊇ read; дефолт — ничего. */
export const KEY_SCOPE_LEVELS = ['read', 'write'] as const;
export type KeyScopeLevel = (typeof KEY_SCOPE_LEVELS)[number];

/** Статусы бота. */
export const BOT_STATUSES = ['active', 'frozen', 'archived'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

/** Причины заморозки бота. */
export const BOT_FROZEN_REASONS = ['creator_left', 'owner', 'platform'] as const;
export type BotFrozenReason = (typeof BOT_FROZEN_REASONS)[number];

/** Ранг бота в организации — им же проецируется в `core/access`. */
export const BOT_RANKS = ['member', 'manager'] as const;
export type BotRank = (typeof BOT_RANKS)[number];

/** Причины отзыва ключа (машинные — слова подбирает каталог). */
export const API_KEY_REVOKE_REASONS = [
  'owner',
  'rotated',
  'member_left',
  'token_epoch',
  'bot_archived',
  'leaked',
  'platform',
  'expired',
  'policy',
] as const;
export type ApiKeyRevokeReason = (typeof API_KEY_REVOKE_REASONS)[number];

/** Статус ключа в реестре (вычисляется из строки). */
export const API_KEY_STATUSES = ['active', 'frozen', 'revoked', 'expired', 'expiring'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/** Виды записи реестра ключей (одна таблица на боты / личные ключи / вебхуки). */
export const KEY_REGISTRY_KINDS = ['bot', 'personal', 'webhook'] as const;
export type KeyRegistryKind = (typeof KEY_REGISTRY_KINDS)[number];

/** Фильтры реестра. */
export const KEY_REGISTRY_FILTERS = ['frozen', 'idle90', 'noExpiry', 'expiring14'] as const;
export type KeyRegistryFilter = (typeof KEY_REGISTRY_FILTERS)[number];

/** Алгоритм подписи endpoint'а вебхука. */
export const WEBHOOK_SIGNINGS = ['hmac', 'ed25519'] as const;
export type WebhookSigning = (typeof WEBHOOK_SIGNINGS)[number];

export const WEBHOOK_ENDPOINT_STATUSES = ['pending_verification', 'active', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'exhausted'] as const;

/** Почему endpoint отключён: серия провалов, руками, платформа, не прошёл проверку, принял битую подпись. */
export const WEBHOOK_DISABLED_REASONS = ['failures', 'manual', 'platform', 'verification', 'signature_audit'] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Машиночитаемые коды отказов движка (`details.code`). Текст — `errors.keys.*`.
 */
export const KEYS_ERROR_CODES = {
  /** Ключи организации создают только владелец и админы */
  roleRequired: 'keys.role_required',
  botFrozen: 'keys.bot.frozen',
  botArchived: 'keys.bot.archived',
  scopeDenied: 'keys.scope.denied',
  ipDenied: 'keys.ip.denied',
  expired: 'keys.expired',
  revoked: 'keys.revoked',
  invalid: 'keys.invalid',
  workspaceMismatch: 'keys.workspace_mismatch',
  personalKeyNeedsWorkspace: 'keys.personal_needs_workspace',
  stepUpRequired: 'keys.step_up_required',
  noExpiryNeedsAllowlist: 'keys.no_expiry_needs_allowlist',
  policyMaxDays: 'keys.policy_max_days',
  familyFull: 'keys.family_full',
  /** Потолок обращений ключа в минуту (`KEYS_LIMITS.requestsPerMinute`) */
  rateLimited: 'keys.rate_limited',
  /** Суточный потолок выгрузки строк одним ключом (`KEYS_LIMITS.exportRowsPerDay`) */
  exportCap: 'keys.export_cap',
  rootMissing: 'keys.root_missing',
  keyUnavailable: 'keys.key_unavailable',
  webhookUrlRejected: 'keys.webhook.url_rejected',
  webhookNotVerified: 'keys.webhook.not_verified',
} as const;
export type KeysErrorCode = (typeof KEYS_ERROR_CODES)[keyof typeof KEYS_ERROR_CODES];

/** Заголовки подписи исходящих вебхуков (Standard Webhooks). */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;

/** Заголовок входящих вебхуков Telegram (`secret_token` при setWebhook). */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
