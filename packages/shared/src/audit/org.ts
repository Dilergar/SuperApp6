import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount, detailDeviceClass, detailId, noDetails } from './types';

// ============================================================
// Организации: состав, роли, владение, жизненный цикл, первый вход с устройства
// ============================================================
// Видят оба: человек («Вы вошли в организацию «Acme»», «Роль: Сотрудник → Менеджер») и
// админ организации. Личные входы человека организация не видит никогда — вместо них
// `org.session.first_seen`: «сотрудник впервые открыл организацию с этого устройства».

const role = detailCode(16);

export const ORG_AUDIT_EVENTS = defineAuditEvents({
  'org.member.invited': {
    category: 'org',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: z.object({ role }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.groupManagement, activityId: A.groupManagement.addUser },
    subjectFrom: 'target',
  },
  'org.member.joined': {
    category: 'org',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: z.object({ role }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.groupManagement, activityId: A.groupManagement.addUser },
    subjectFrom: 'actor',
  },
  'org.member.removed': {
    category: 'org',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z.object({ role: role.optional() }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.groupManagement, activityId: A.groupManagement.removeUser },
    subjectFrom: 'target',
  },
  'org.member.left': {
    category: 'org',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: z.object({ role: role.optional() }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.groupManagement, activityId: A.groupManagement.removeUser },
    subjectFrom: 'actor',
  },
  'org.role.changed': {
    category: 'org',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z.object({ from: role, to: role, source: z.enum(['manual', 'ownership']) }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.userAccessManagement, activityId: A.userAccessManagement.assignPrivileges },
    subjectFrom: 'target',
  },
  /** Приглашение отозвано до принятия — цель: приглашение (адресата-аккаунта может ещё не быть) */
  'org.member.invitation_cancelled': {
    category: 'org',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ role: role.optional() }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.groupManagement, activityId: A.groupManagement.removeUser },
  },
  /** Цель — новый владелец; прежний владелец — в `related` */
  'org.ownership.transferred': {
    category: 'org',
    severity: 'high',
    visibility: AUDIT_VIS.both,
    details: noDetails(),
    vocab: 'authz_admin',
    ocsf: { classUid: C.userAccessManagement, activityId: A.userAccessManagement.assignPrivileges },
    subjectFrom: 'target',
  },
  /** Организация создана — первый факт её журнала; субъект — создатель (он же владелец) */
  'org.workspace.created': {
    category: 'org',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: noDetails(),
    vocab: 'sensitive_create',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.create },
    subjectFrom: 'actor',
  },
  'org.workspace.archived': {
    category: 'org',
    severity: 'high',
    visibility: AUDIT_VIS.both,
    details: noDetails(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.deactivate },
    subjectFrom: 'actor',
  },
  'org.workspace.restored': {
    category: 'org',
    severity: 'high',
    visibility: AUDIT_VIS.both,
    details: noDetails(),
    vocab: 'sensitive_update',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.activate },
    subjectFrom: 'actor',
  },
  /** Окончательное удаление: журнал организации ПЕРЕЖИВАЕТ purge (строки без FK) */
  'org.workspace.purged': {
    category: 'org',
    severity: 'critical',
    visibility: AUDIT_VIS.both,
    details: z.object({ members: detailCount() }).strict(),
    vocab: 'sensitive_delete',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Сотрудник впервые открыл организацию с этого устройства — класс устройства и страна, без IP */
  'org.session.first_seen': {
    category: 'org',
    severity: 'info',
    visibility: AUDIT_VIS.both,
    details: z.object({ deviceClass: detailDeviceClass() }).strict(),
    vocab: 'session_created',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
    subjectFrom: 'actor',
  },
  /** Организация включила/выключила стрим журнала во внешний SIEM (подписка вебхука на `security.*`) */
  'org.audit.stream_changed': {
    category: 'org',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ enabled: z.boolean(), categories: detailCount() }).strict(),
    vocab: 'sys_monitor_enabled',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  /**
   * Политика видимости организации опубликована (core/visibility): тип записи, версия, сколько
   * пар «поле × адресат» стали виднее/скрытнее, ослаблены ли строгие поля, выдано ли
   * делегирование раскрытия. Сами правила — в версии политики (дифф — «Версии»).
   */
  'org.visibility.policy_published': {
    category: 'org',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z
      .object({
        recordType: detailCode(64),
        version: detailCount(),
        widened: detailCount(),
        narrowed: detailCount(),
        weakensRestricted: z.boolean(),
        revealDelegated: z.boolean(),
      })
      .strict(),
    vocab: 'authz_change',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  /** «Проверить сотрудника»: админ посмотрел план чужого зрителя (только чтение, без токенов) */
  'org.visibility.explain_viewed': {
    category: 'org',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ recordType: detailCode(64), viewer: detailId() }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.read },
    subjectFrom: 'target',
  },
  /** Настройки политики: push о раскрытии, «четыре глаза», делегирование */
  'org.visibility.settings_changed': {
    category: 'org',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ notifyOnReveal: z.boolean(), dualControl: z.boolean(), allowDelegation: z.boolean() }).strict(),
    vocab: 'authz_change',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
});
