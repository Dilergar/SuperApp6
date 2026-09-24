import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { ACCOUNT_FREEZE_SOURCES, AUDIT_INTEGRATION_PROVIDERS, AUDIT_INTEGRATION_REASONS, AUDIT_VIS, defineAuditEvents, detailCount, detailDeviceClass, noDetails } from './types';

// ============================================================
// Аккаунт человека: жизненный цикл, заморозка, «Это не я», устройства, настройки
// ============================================================

export const ACCOUNT_AUDIT_EVENTS = defineAuditEvents({
  'account.registered': {
    category: 'account',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: noDetails(),
    vocab: 'user_created',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.create },
    subjectFrom: 'actor',
  },
  'account.deletion_requested': {
    category: 'account',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    disputable: true,
    details: z.object({ graceDays: detailCount() }).strict(),
    vocab: 'user_archived',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.disable },
    subjectFrom: 'actor',
  },
  'account.deletion_cancelled': {
    category: 'account',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    details: noDetails(),
    vocab: 'user_updated',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.enable },
    subjectFrom: 'actor',
  },
  /** Анонимизация по истечении окна удаления — пишет крон; человеку уже не показать, платформе — след */
  'account.anonymized': {
    category: 'account',
    severity: 'high',
    visibility: AUDIT_VIS.platform,
    details: noDetails(),
    vocab: 'user_deleted',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.delete },
  },
  /** Заморозка: вход, сессии и ключи API закрыты до разморозки паролем + SMS */
  'account.frozen': {
    category: 'account',
    severity: 'critical',
    visibility: AUDIT_VIS.subject,
    notify: 'security.account.frozen',
    details: z.object({ by: z.enum(ACCOUNT_FREEZE_SOURCES), sessionsRevoked: detailCount(), keysRevoked: detailCount() }).strict(),
    vocab: 'user_archived',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.lock },
  },
  'account.unfrozen': {
    category: 'account',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    notify: 'security.account.unfrozen',
    details: z.object({ by: z.enum(ACCOUNT_FREEZE_SOURCES) }).strict(),
    vocab: 'user_updated',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.unlock },
  },
  /** Мастер «Это не я», шаг 1: завершены чужие сессии, забыты устройства, отозваны ключи */
  'account.not_me_started': {
    category: 'account',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    details: z
      .object({ sessionsRevoked: detailCount(), devicesForgotten: detailCount(), keysRevoked: detailCount(), googleDisconnected: z.boolean() })
      .strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.other },
    subjectFrom: 'actor',
  },
  'account.not_me_completed': {
    category: 'account',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    notify: 'security.notMe.completed',
    details: z.object({ credentialsRotated: z.boolean(), numberConfirmed: z.boolean() }).strict(),
    vocab: 'user_updated',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.other },
    subjectFrom: 'actor',
  },
  /**
   * Устройство забыто (человеком из другой сессии, мастером или кроном по бездействию). Уведомление —
   * когда забыли из другой сессии; мастер «Это не я» и крон шлют `notify: false`.
   */
  'account.device_forgotten': {
    category: 'account',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    notify: 'security.device.forgotten',
    details: z.object({ deviceClass: detailDeviceClass(), auto: z.boolean(), sessionsRevoked: detailCount() }).strict(),
    vocab: 'authn_token_delete',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  'account.device_renamed': {
    category: 'account',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: noDetails(),
    vocab: 'user_updated',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
    subjectFrom: 'actor',
  },
  /** Человек оспорил событие («Это не я») — `ref` указывает на событие-причину */
  'account.event_disputed': {
    category: 'account',
    severity: 'high',
    visibility: AUDIT_VIS.subject,
    details: noDetails(),
    vocab: 'authz_fail',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.other },
    subjectFrom: 'actor',
  },
  /**
   * Внешнее приложение получило доступ к данным аккаунта (OAuth-интеграция: Google Календарь).
   * Передача данных наружу — отдельным учётом `pd.cross_border`; здесь — выданный доступ.
   */
  'account.integration.connected': {
    category: 'account',
    severity: 'medium',
    visibility: AUDIT_VIS.subject,
    details: z.object({ provider: z.enum(AUDIT_INTEGRATION_PROVIDERS) }).strict(),
    vocab: 'authn_token_created',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.attachPolicy },
    subjectFrom: 'actor',
  },
  /** Доступ приложения закрыт — любым путём: сам человек, «Это не я», удаление аккаунта, отзыв у провайдера */
  'account.integration.disconnected': {
    category: 'account',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ provider: z.enum(AUDIT_INTEGRATION_PROVIDERS), reason: z.enum(AUDIT_INTEGRATION_REASONS) }).strict(),
    vocab: 'authn_token_revoked',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.detachPolicy },
  },
  'account.settings_changed': {
    category: 'account',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ sessionMaxIdleDays: detailCount() }).strict(),
    vocab: 'user_updated',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.other },
    subjectFrom: 'actor',
  },
});
