import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount, detailId, detailIso, detailNote, noDetails, type AuditEventDef, type AuditSeverity } from './types';

// ============================================================
// Ключи API, боты, вебхуки, криптография и политика (core/keys, core/webhooks)
// ============================================================
// Бывший `KeyAuditEntry`: ключ события = `keys.<предмет>.<действие>`, исходная строка
// действия движка ключей едет в `op` (вкладка «Журнал» реестра ключей читает проекцию).
// Имя ключа/бота/адрес вебхука — `target_label` (снимок, переживает удаление; адрес — без
// query и userinfo). Личный ключ человека виден и ему самому (субъект), ключи организации —
// её админам; криптография платформы — только платформе.

const fields = z.array(detailCode(32)).max(16);
const keyKind = z.enum(['bot', 'pat']);

/** Детали событий криптографии — общий набор (все поля необязательны: у каждого действия свои). */
const cryptoDetails = z
  .object({
    kid: detailCode(80).optional(),
    rootKid: detailCode(80).optional(),
    state: detailCode(32).optional(),
    slot: detailCount().optional(),
    versions: detailCount().optional(),
    rows: detailCount().optional(),
    remaining: detailCount().optional(),
    broken: detailCount().optional(),
    filled: detailCount().optional(),
    unavailable: detailCount().optional(),
    conflicts: detailCount().optional(),
    underNext: detailCount().optional(),
    at: detailIso().optional(),
    stateBefore: detailCode(32).optional(),
    note: detailNote().optional(),
  })
  .strict();

const crypto = (severity: AuditSeverity, activityId: number) =>
  ({
    category: 'keys',
    severity,
    visibility: AUDIT_VIS.workspace,
    details: cryptoDetails,
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId },
  }) as const satisfies AuditEventDef;

export const KEYS_AUDIT_EVENTS = defineAuditEvents({
  // ---- Ключи API ----
  'keys.api_key.created': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z
      .object({
        kind: keyKind,
        prefix: detailCode(64),
        expiresAt: detailIso().nullable().optional(),
        scopes: detailCount().optional(),
        botId: detailId().optional(),
        /** core/visibility R9: ключу открыт класс `contact` */
        contactAccess: z.boolean().optional(),
      })
      .strict(),
    vocab: 'authn_token_created',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.create },
  },
  'keys.api_key.updated': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: z.object({ fields, contactAccess: z.boolean().optional() }).strict(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  'keys.api_key.rotated': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z
      .object({
        kind: keyKind.optional(),
        prefix: detailCode(64).optional(),
        botId: detailId().optional(),
        expiresAt: detailIso().nullable().optional(),
        rotatedFromId: detailId(),
        graceUntil: detailIso().nullable().optional(),
      })
      .strict(),
    vocab: 'authn_token_created',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  'keys.api_key.revoked': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z.object({ reason: detailCode(32), note: detailNote().optional() }).strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.disable },
  },
  /** Сигнал сканера секретов: ключ найден в открытом доступе и отозван */
  'keys.api_key.leaked': {
    category: 'keys',
    severity: 'critical',
    visibility: AUDIT_VIS.both,
    details: z.object({ note: detailNote().optional() }).strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.disable },
  },
  'keys.api_key.expired': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: z.object({ kind: keyKind }).strict(),
    vocab: 'session_expired',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.deactivate },
  },
  /**
   * Отказ аутентификации ключом. Схлопывается (одна строка на ключ/префикс, сеть и причину
   * за окно — `attempts` в строке): перебор не превращает журнал в флуд.
   */
  'keys.api_key.auth_failed': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ failure: z.enum(['invalid', 'revoked', 'expired', 'frozen', 'archived']), attempts: detailCount() }).strict(),
    vocab: 'authn_login_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
  },
  'keys.api_key.ip_denied': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ attempts: detailCount() }).strict(),
    vocab: 'authz_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
  },
  'keys.api_key.throttled': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ attempts: detailCount() }).strict(),
    vocab: 'excess_rate_limit_exceeded',
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.other },
  },
  // ---- Боты ----
  'keys.bot.created': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ rank: detailCode(16), scopes: detailCount(), responsibleUserId: detailId().nullable().optional(), contactAccess: z.boolean().optional() }).strict(),
    vocab: 'user_created',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.create },
  },
  'keys.bot.updated': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ fields, contactAccess: z.boolean().optional() }).strict(),
    vocab: 'user_updated',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  'keys.bot.frozen': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ reason: detailCode(32) }).strict(),
    vocab: 'user_archived',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.suspend },
  },
  'keys.bot.unfrozen': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ note: detailNote().optional() }).strict(),
    vocab: 'user_updated',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.resume },
  },
  'keys.bot.archived': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ keysRevoked: detailCount() }).strict(),
    vocab: 'user_deleted',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  // ---- Вебхуки ----
  'keys.webhook.created': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ signing: detailCode(16), events: detailCount() }).strict(),
    vocab: 'sensitive_create',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.create },
  },
  'keys.webhook.updated': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ events: detailCount() }).strict(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  'keys.webhook.enabled': {
    category: 'keys',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: noDetails(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.enable },
  },
  'keys.webhook.disabled': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ reason: detailCode(32) }).strict(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.disable },
  },
  'keys.webhook.deleted': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: noDetails(),
    vocab: 'sensitive_delete',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  'keys.webhook.secret_rotated': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ prevHours: detailCount() }).strict(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  'keys.webhook.verified': {
    category: 'keys',
    severity: 'info',
    visibility: AUDIT_VIS.workspace,
    details: noDetails(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.activate },
  },
  /** Приёмник принял заведомо поддельную подпись — адрес выключен (аудит подписи) */
  'keys.webhook.signature_audit': {
    category: 'keys',
    severity: 'high',
    visibility: AUDIT_VIS.workspace,
    details: noDetails(),
    vocab: 'authz_fail',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.disable },
  },
  // ---- Политика ключей организации ----
  'keys.policy.changed': {
    category: 'keys',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z
      .object({ maxPatDays: detailCount().optional(), maxBotKeyDays: detailCount().nullable().optional(), requireAllowlist: z.boolean().optional() })
      .strict(),
    vocab: 'authz_change',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  // ---- Криптография (keystore) ----
  'keys.crypto.key_created': crypto('low', A.entityManagement.create),
  'keys.crypto.version_created': crypto('low', A.entityManagement.create),
  'keys.crypto.version_activated': crypto('low', A.entityManagement.activate),
  'keys.crypto.version_disabled': crypto('high', A.entityManagement.disable),
  'keys.crypto.version_enabled': crypto('high', A.entityManagement.enable),
  'keys.crypto.version_destroy_scheduled': crypto('high', A.entityManagement.update),
  'keys.crypto.version_destroyed': crypto('medium', A.entityManagement.delete),
  'keys.crypto.version_compromised': crypto('critical', A.entityManagement.disable),
  'keys.crypto.scope_frozen': crypto('critical', A.entityManagement.suspend),
  'keys.crypto.scope_unfrozen': crypto('high', A.entityManagement.resume),
  'keys.crypto.scope_rewrapped': crypto('info', A.entityManagement.update),
  'keys.crypto.root_rotation_started': crypto('critical', A.entityManagement.update),
  'keys.crypto.root_rotated': crypto('high', A.entityManagement.update),
  'keys.crypto.blind_index_rotated': crypto('medium', A.entityManagement.update),
});
