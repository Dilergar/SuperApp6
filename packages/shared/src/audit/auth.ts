import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import {
  AUDIT_VIS,
  SESSION_REVOKE_REASONS,
  defineAuditEvents,
  detailCode,
  detailCount,
  detailCountry,
  detailDeviceClass,
  detailHmac,
  noDetails,
} from './types';

// ============================================================
// Вход, сессии и учётные данные человека (core/auth, core/users, core/verify)
// ============================================================
// Личные входы видит сам человек и платформа — организация НИКОГДА (решение грилла №2).
// «Сессия» для человека = семейство refresh-цепочки (`familyId`): строка ротируется на
// каждом refresh, а вход — это начало семейства.

/** Как человек вошёл: пароль · автовход после регистрации · после разморозки · после сброса пароля по SMS. */
const loginMethod = z.enum(['password', 'register', 'unfreeze', 'reset']);
const stepUpPurpose = detailCode(32);

export const AUTH_AUDIT_EVENTS = defineAuditEvents({
  'auth.login.success': {
    category: 'auth',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    details: z.object({ method: loginMethod, newDevice: z.boolean(), newCountry: z.boolean() }).strict(),
    vocab: 'authn_login_success',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
    subjectFrom: 'actor',
  },
  /**
   * Неудачный вход. Неизвестный номер — без субъекта, с HMAC-псевдонимом номера (`targetHmac`):
   * spray по многим номерам с одного IP виден без открытого номера в журнале.
   * Во время блокировки попытки построчно НЕ пишутся (флуд) — их итог `audit.lockout_summary`.
   */
  'auth.login.failed': {
    category: 'auth',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ targetHmac: detailHmac().optional(), attempt: detailCount().optional() }).strict(),
    vocab: 'authn_login_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
  },
  'auth.login.locked': {
    category: 'auth',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    notify: 'security.login.locked',
    details: z.object({ attempts: detailCount(), minutes: detailCount(), level: detailCount() }).strict(),
    vocab: 'authn_login_fail_max',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.lock },
  },
  'auth.logout': {
    category: 'auth',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: noDetails(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logoff },
    subjectFrom: 'actor',
  },
  'auth.logout_all': {
    category: 'auth',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    details: z.object({ sessions: detailCount() }).strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logoff },
    subjectFrom: 'actor',
  },
  // ---- Сессии и устройства (категория session) ----
  'auth.session.revoked': {
    category: 'session',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ by: z.enum(SESSION_REVOKE_REASONS), sessions: detailCount() }).strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logoff },
  },
  /** Прокрученный refresh-токен предъявлен повторно вне grace (RFC 9700 §2.2.2): семейство отозвано */
  'auth.session.refresh_reuse': {
    category: 'session',
    severity: 'critical',
    visibility: AUDIT_VIS.subject,
    notify: 'auth.session.reuseDetected',
    details: z.object({ sessions: detailCount() }).strict(),
    vocab: 'authn_token_reuse',
    ocsf: { classUid: C.authentication, activityId: A.authentication.authTicket },
  },
  'auth.session.new_device': {
    category: 'session',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    notify: 'security.login.newDevice',
    details: z.object({ deviceClass: detailDeviceClass(), quiet: z.boolean() }).strict(),
    vocab: 'session_created',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
    subjectFrom: 'actor',
  },
  'auth.session.new_country': {
    category: 'session',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    notify: 'security.login.newCountry',
    details: z.object({ previousCountry: detailCountry().optional() }).strict(),
    vocab: 'session_created',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
    subjectFrom: 'actor',
  },
  /** Новая сессия подтверждена (step-up) либо стала доверенной по сроку cooling */
  'auth.session.confirmed': {
    category: 'session',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: z.object({ via: z.enum(['step_up', 'elapsed']) }).strict(),
    vocab: 'session_renewed',
    ocsf: { classUid: C.authentication, activityId: A.authentication.other },
    subjectFrom: 'actor',
  },
  /** Автозавершение неактивных — агрегат на человека за прогон крона */
  'auth.session.expired_inactive': {
    category: 'session',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: z.object({ sessions: detailCount(), idleDays: detailCount() }).strict(),
    vocab: 'session_expired',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logoff },
  },
  // ---- Учётные данные ----
  'auth.password.changed': {
    category: 'auth',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    notify: 'auth.password.changed',
    details: z.object({ via: z.enum(['settings', 'not_me']), sessionsRevoked: detailCount() }).strict(),
    vocab: 'authn_password_change',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.passwordChange },
    subjectFrom: 'actor',
  },
  'auth.password.reset_completed': {
    category: 'auth',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    notify: 'auth.password.changed',
    details: z.object({ sessionsRevoked: detailCount(), unlocked: z.boolean() }).strict(),
    vocab: 'authn_password_change',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.passwordReset },
  },
  'auth.phone.changed': {
    category: 'auth',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    details: z.object({ sessionsRevoked: detailCount() }).strict(),
    vocab: 'user_updated',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.other },
    subjectFrom: 'actor',
  },
  'auth.otp.failed': {
    category: 'auth',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ purpose: stepUpPurpose, attemptsLeft: detailCount() }).strict(),
    vocab: 'authn_login_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.preauth },
  },
  'auth.otp.locked': {
    category: 'auth',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    details: z.object({ purpose: stepUpPurpose }).strict(),
    vocab: 'authn_login_fail_max',
    ocsf: { classUid: C.authentication, activityId: A.authentication.preauth },
  },
  'auth.step_up.success': {
    category: 'auth',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: z.object({ purpose: stepUpPurpose }).strict(),
    vocab: 'authn_login_success',
    ocsf: { classUid: C.authentication, activityId: A.authentication.preauth },
    subjectFrom: 'actor',
  },
  'auth.step_up.failed': {
    category: 'auth',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ purpose: stepUpPurpose, stage: z.enum(['password', 'sms']) }).strict(),
    vocab: 'authn_login_fail',
    ocsf: { classUid: C.authentication, activityId: A.authentication.preauth },
    subjectFrom: 'actor',
  },
});
