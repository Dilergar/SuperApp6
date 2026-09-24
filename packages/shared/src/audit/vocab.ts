// ============================================================
// OWASP Logging Vocabulary — внешнее имя события для SIEM и расследований
// (https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html).
// Внутренний ключ реестра остаётся нашим; `vocab` — мост к общему языку отрасли.
// ============================================================

export const AUDIT_VOCAB = [
  'authn_login_success',
  'authn_login_successafterfail',
  'authn_login_fail',
  'authn_login_fail_max',
  'authn_login_lock',
  'authn_password_change',
  'authn_password_change_fail',
  'authn_impossible_travel',
  'authn_token_created',
  'authn_token_revoked',
  'authn_token_reuse',
  'authn_token_delete',
  'authz_fail',
  'authz_change',
  'authz_admin',
  'excess_rate_limit_exceeded',
  'privilege_permissions_changed',
  'sensitive_create',
  'sensitive_read',
  'sensitive_update',
  'sensitive_delete',
  'session_created',
  'session_renewed',
  'session_expired',
  'session_use_after_expire',
  'user_created',
  'user_updated',
  'user_archived',
  'user_deleted',
  'sys_monitor_disabled',
  'sys_monitor_enabled',
  'upload_validation',
  'malicious_direct_reference',
] as const;
export type AuditVocab = (typeof AUDIT_VOCAB)[number];

export function isAuditVocab(value: unknown): value is AuditVocab {
  return typeof value === 'string' && (AUDIT_VOCAB as readonly string[]).includes(value);
}
