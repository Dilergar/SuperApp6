// ============================================================
// core/keys — константы движка (джобы, очереди, имена ключей)
// ============================================================

export const KEYS_QUEUE = 'keys';

export const KEYS_JOBS = {
  /** Перешить DEK'и всех полей KEK'а на его primary-версию (после ротации KEK) */
  rewrap: 'keys.rewrap',
  /** Пересчитать слепые индексы на primary-версию mac-ключа (только при компрометации) */
  reindex: 'keys.reindex',
  /** pending → active у версии подписи (после протухания кэша JWKS) */
  signingActivate: 'keys.signing.activate',
  /** Старая версия подписи после окна максимального срока токена → destroy_scheduled */
  signingRetire: 'keys.signing.retire',
  /** Уничтожение версий по сроку (destroy_scheduled → destroyed) */
  destroySweep: 'keys.destroy.sweep',
  /** Перешивка строк прошлой эпохи (производные ключи / открытый текст) in envelope */
  legacyReencrypt: 'keys.legacy.reencrypt',
  /** Бэкфилл ПДн: `_enc`/`_bi` для строк с открытым текстом (фаза D) */
  piiBackfill: 'keys.pii.backfill',
} as const;

/** Имя единственного KEK в скоупе. */
export const KEK_NAME = 'default';

/** Скоуп-строка keystore. */
export const PLATFORM_SCOPE = 'platform';
export const workspaceScope = (id: string) => `workspace:${id}`;
export const userScope = (id: string) => `user:${id}`;

/** Ключи журнала ключей (`KeyAuditEntry.action`). */
export const KEY_AUDIT_ACTIONS = {
  keyCreated: 'crypto_key.created',
  versionCreated: 'key_version.created',
  versionActivated: 'key_version.activated',
  versionDisabled: 'key_version.disabled',
  versionEnabled: 'key_version.enabled',
  versionDestroyScheduled: 'key_version.destroy_scheduled',
  versionDestroyed: 'key_version.destroyed',
  scopeFrozen: 'scope.frozen',
  scopeUnfrozen: 'scope.unfrozen',
  rootRotated: 'root.rotated',
  rewrapDone: 'scope.rewrapped',
} as const;

/** Тип ссылки уведомлений/панелей движка. */
export const KEYS_NOTIFICATION_REF_TYPE = 'api_key';
export const BOT_NOTIFICATION_REF_TYPE = 'bot';
export const WEBHOOK_NOTIFICATION_REF_TYPE = 'webhook_endpoint';
