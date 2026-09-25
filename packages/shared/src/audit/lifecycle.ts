import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount, detailIso } from './types';

// ============================================================
// Жизненный цикл данных (core/lifecycle) — доказательство каждого прогона и каждого стирания
// ============================================================
// NIST 800-88 «certificate of sanitization»: удаление, которое нельзя доказать, для регулятора
// не случилось. Прогон purge, сброс и архив партиции, заморозка, этап стирания субъекта,
// смена срока организацией — событие журнала безопасности. Детали — коды и счётчики: имя
// политики (id реестра), имя партиции, класс данных; ни одного значения из стёртых строк.

/** Класс данных в деталях — код реестра (`packages/shared/src/lifecycle`). */
const dataClass = () => detailCode(32);
/** Этапы стирания субъекта (сертификат) */
export const LIFECYCLE_ERASURE_STAGES = ['requested', 'hidden', 'hot_purged', 'keys_destroyed', 'backups_clear', 'completed', 'cancelled'] as const;
/** Области заморозки (legal hold) */
export const LIFECYCLE_HOLD_SCOPES = ['custodian', 'space', 'record', 'class'] as const;

export const LIFECYCLE_AUDIT_EVENTS = defineAuditEvents({
  /** Прогон раннера purge по одной политике (батчи, строки, dry-run) */
  'lifecycle.purge.run': {
    category: 'lifecycle',
    status: 'live',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z
      .object({
        policy: detailCode(64),
        rows: detailCount(),
        batches: detailCount(),
        dryRun: z.boolean(),
        stopped: detailCode(32).optional(),
      })
      .strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Партиция сброшена по сроку (DETACH CONCURRENTLY → DROP) */
  'lifecycle.partition.dropped': {
    category: 'lifecycle',
    status: 'planned',
    severity: 'low',
    visibility: AUDIT_VIS.platform,
    details: z.object({ policy: detailCode(64), partition: detailCode(96), rows: detailCount(), held: detailCount() }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Партиция выгружена в холодный ярус (NDJSON.gz + подписанный манифест) до сброса */
  'lifecycle.partition.archived': {
    category: 'lifecycle',
    status: 'planned',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z.object({ policy: detailCode(64), partition: detailCode(96), rows: detailCount(), bytes: detailCount() }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.other },
  },
  /** Заморозка поставлена (удаление по области остановлено) — организация видит свою */
  'lifecycle.hold.created': {
    category: 'lifecycle',
    status: 'live',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ scope: z.enum(LIFECYCLE_HOLD_SCOPES), holdId: detailCode(40) }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.suspend },
  },
  /** Заморозка снята — удаление возобновится по политике */
  'lifecycle.hold.released': {
    category: 'lifecycle',
    status: 'live',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ scope: z.enum(LIFECYCLE_HOLD_SCOPES), holdId: detailCode(40) }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.resume },
  },
  /** Заявка на стирание субъекта принята (человек или организация) */
  'lifecycle.erasure.requested': {
    category: 'lifecycle',
    status: 'live',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z.object({ subjectType: z.enum(['user', 'workspace']), effectiveAt: detailIso() }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Этап стирания пройден (скрыто → горячее стёрто → ключи уничтожены → бэкапы очищены) */
  'lifecycle.erasure.stage': {
    category: 'lifecycle',
    status: 'live',
    severity: 'info',
    visibility: AUDIT_VIS.platform,
    details: z.object({ stage: z.enum(LIFECYCLE_ERASURE_STAGES), rows: detailCount(), policies: detailCount() }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Стирание завершено, сертификат подписан */
  'lifecycle.erasure.completed': {
    category: 'lifecycle',
    status: 'live',
    severity: 'medium',
    visibility: AUDIT_VIS.platform,
    details: z.object({ subjectType: z.enum(['user', 'workspace']), rows: detailCount(), policies: detailCount(), keys: detailCount() }).strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.delete },
  },
  /** Организация сменила срок хранения класса данных (сокращение вступает через 30 дней) */
  'lifecycle.settings.changed': {
    category: 'lifecycle',
    status: 'live',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z
      .object({
        dataClass: dataClass(),
        fromDays: detailCount().nullable(),
        toDays: detailCount().nullable(),
        effectiveAt: detailIso(),
        shortened: z.boolean(),
      })
      .strict(),
    ocsf: { classUid: C.entityManagement, activityId: A.entityManagement.update },
  },
  /** Ночная канарейка нашла след стёртого синтетического субъекта — стирание где-то протекает */
  'lifecycle.canary.failed': {
    category: 'lifecycle',
    status: 'live',
    severity: 'critical',
    visibility: AUDIT_VIS.platform,
    details: z.object({ stores: detailCount(), findings: detailCount() }).strict(),
    ocsf: { classUid: C.detectionFinding, activityId: A.detectionFinding.create },
  },
});
