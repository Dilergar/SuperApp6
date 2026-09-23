import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount, detailIso } from './types';

// ============================================================
// Журнал о самом себе: кто смотрел журнал, дайджесты целостности, архив партиций,
// настройки и агрегаты схлопнутых строк (NIST AU-9: защита журнала — тоже событие)
// ============================================================

export const META_AUDIT_EVENTS = defineAuditEvents({
  /** Просмотр журнала сотрудником платформы — агрегат на (актор, час): мета-аудит поиска */
  'audit.viewed': {
    category: 'audit',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z.object({ queries: detailCount(), rows: detailCount(), reveals: detailCount() }).strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.search },
  },
  'audit.digest.created': {
    category: 'audit',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z.object({ digestId: z.string().max(32), rows: detailCount() }).strict(),
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.create },
  },
  'audit.digest.verified': {
    category: 'audit',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z.object({ digests: detailCount(), rows: detailCount(), from: detailIso(), to: detailIso() }).strict(),
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.read },
  },
  'audit.digest.failed': {
    category: 'audit',
    severity: 'critical',
    visibility: AUDIT_VIS.platform,
    details: z.object({ digests: detailCount(), mismatched: detailCount(), from: detailIso(), to: detailIso() }).strict(),
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.read },
  },
  /** Партиция выгружена в архив (NDJSON+gzip с подписанным манифестом) */
  'audit.partition.archived': {
    category: 'audit',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z.object({ partition: detailCode(48), rows: detailCount(), bytes: detailCount() }).strict(),
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.export },
  },
  /** Партиция сброшена по сроку — ТОЛЬКО после успешной выгрузки */
  'audit.partition.dropped': {
    category: 'audit',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: z.object({ partition: detailCode(48) }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Смена настроек журнала (интервал дайджестов, архив, ретеншн) — CRITICAL + четыре глаза */
  'audit.settings.changed': {
    category: 'audit',
    severity: 'critical',
    visibility: AUDIT_VIS.platform,
    details: z.object({ setting: detailCode(48) }).strict(),
    vocab: 'sys_monitor_disabled',
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
    status: 'planned',
  },
  /** Итог блокировки входа: сколько попыток отбито, пока аккаунт был заблокирован (построчно не пишутся) */
  'audit.lockout_summary': {
    category: 'audit',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: z.object({ attempts: detailCount() }).strict(),
    vocab: 'authn_login_fail_max',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
  },
});
