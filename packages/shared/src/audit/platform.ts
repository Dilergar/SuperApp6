import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount, detailId, detailIso, detailNote, detailSnapshot, noDetails } from './types';

// ============================================================
// Кабинет платформы (core/platform): вход сотрудников, команды, заявки four-eyes, чтения
// ============================================================
// Действия сотрудников платформы людям и организациям НЕ показываются (решение грилла
// №3): у всех ключей видимость — только платформа. Бывшие `PlatformAuditEntry` (команды)
// и `PlatformAccessLog` (чтения): ключ команды — в `op`, квитанция идемпотентности —
// в `platform_command_receipts`.

const reveal = z.array(detailCode(64)).max(32);

export const PLATFORM_AUDIT_EVENTS = defineAuditEvents({
  'platform.auth.login_success': {
    category: 'platform',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: noDetails(),
    vocab: 'authn_login_success',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
    subjectFrom: 'actor',
  },
  'platform.auth.login_failed': {
    category: 'platform',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: z.object({ stage: z.enum(['start', 'otp']) }).strict(),
    vocab: 'authn_login_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
  },
  'platform.auth.login_locked': {
    category: 'platform',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: noDetails(),
    vocab: 'authn_login_fail_max',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.lock },
  },
  'platform.auth.step_up_success': {
    category: 'platform',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: noDetails(),
    vocab: 'authn_login_success',
    ocsf: { classUid: C.authentication, activityId: A.authentication.preauth },
    subjectFrom: 'actor',
  },
  'platform.auth.step_up_failed': {
    category: 'platform',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: noDetails(),
    vocab: 'authn_login_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.preauth },
    subjectFrom: 'actor',
  },
  'platform.auth.session_revoked': {
    category: 'platform',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: z.object({ by: z.enum(['self', 'all', 'system']), sessions: detailCount() }).strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logoff },
    subjectFrom: 'actor',
  },
  /**
   * Команда Кабинета исполнена (или отказана). `op` = ключ команды; вход — УЖЕ замаскирован
   * декларацией команды (`redact[]` + автомаскирование по имени поля); `before/after` — снимки.
   */
  'platform.command.executed': {
    category: 'platform',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: z
      .object({
        version: detailCount(),
        input: detailSnapshot(),
        inputHash: detailCode(128).nullable().optional(),
        before: detailSnapshot(),
        after: detailSnapshot(),
        error: detailCode(96).nullable().optional(),
        readOnly: z.boolean(),
        risk: z.enum(['low', 'medium', 'high', 'critical']),
        reason: detailNote().nullable().optional(),
        ticketRef: detailCode(128).nullable().optional(),
        approvalId: detailId().nullable().optional(),
        stepUpAt: detailIso().nullable().optional(),
        dryRun: z.boolean(),
        durationMs: detailCount(),
        /** Ключ повтора команды (клиентский uuid; квитанция — `platform_command_receipts`) */
        idempotency: z.string().max(128).nullable().optional(),
      })
      .strict(),
    vocab: 'authz_admin',
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.update },
  },
  'platform.request.created': {
    category: 'platform',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: z.object({ command: detailCode(96) }).strict(),
    vocab: 'authz_admin',
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.create },
  },
  'platform.request.decided': {
    category: 'platform',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: z.object({ command: detailCode(96), decision: z.enum(['approved', 'rejected']) }).strict(),
    vocab: 'authz_admin',
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.update },
  },
  'platform.request.withdrawn': {
    category: 'platform',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: z.object({ command: detailCode(96) }).strict(),
    vocab: 'authz_admin',
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.delete },
  },
  // ---- Чтения (best-effort вне транзакции: икота БД не должна валить Кабинет) ----
  'platform.access.search': {
    category: 'platform',
    severity: 'low',
    visibility: AUDIT_VIS.platform,
    details: z.object({ fields: reveal.optional() }).strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.search },
  },
  'platform.access.view': {
    category: 'platform',
    severity: 'low',
    visibility: AUDIT_VIS.platform,
    details: z.object({ fields: reveal.optional() }).strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.read },
  },
  /** Раскрытие маскированных ПДн (полный номер, ИИН, IP события) — всегда с перечнем полей */
  'platform.access.reveal': {
    category: 'platform',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: z.object({ fields: reveal.optional() }).strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.read },
  },
  /** Система приостановила сотрудника (аккаунт анонимизирован, компрометация) */
  'platform.staff.suspended_by_system': {
    category: 'platform',
    severity: 'critical',
    visibility: AUDIT_VIS.platform,
    details: z.object({ reason: detailCode(32) }).strict(),
    vocab: 'authz_change',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.disable },
  },
});
