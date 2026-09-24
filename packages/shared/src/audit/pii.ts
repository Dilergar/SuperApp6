import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount } from './types';

const revealFields = z.array(detailCode(64)).min(1).max(12);

// ============================================================
// Чтения ПДн ограниченного доступа (приказ МЦРИАП № 179/НҚ; бывший `pii_access_log`)
// ============================================================
// Агрегат на запрос: кто, какую сущность, какие поля, сколько строк (+ до 10 id образцом).
// Пишет ПДн-слой движка ключей при расшифровке полей `sensitive` (ИИН, дата рождения,
// удостоверение, адрес, IBAN) батчем вне транзакции (best-effort + метрика отказов).
// Организация видит чтения ПДн своих сотрудников внутри себя.

export const PII_AUDIT_EVENTS = defineAuditEvents({
  'pii.read': {
    category: 'pii',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z
      .object({
        entity: detailCode(64),
        fields: z.array(detailCode(64)).max(32),
        count: detailCount(),
        sampleIds: z.array(z.string().max(64)).max(10),
      })
      .strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.datastoreActivity, activityId: A.datastoreActivity.read },
  },
  /**
   * Раскрытие маскированного поля ОДНОЙ записи (core/visibility, break-glass): кто, чьё, какие
   * поля. Видит и сам человек (ЗоПД ст. 24: «Мои данные»), и его организация. Значений нет —
   * только коды полей. `delegated` — раскрыл адресат по делегированию, а не владелец/админ.
   */
  'pii.reveal': {
    category: 'pii',
    severity: 'medium',
    visibility: AUDIT_VIS.both,
    details: z
      .object({
        recordType: detailCode(64),
        fields: revealFields,
        mode: z.enum(['one']),
        delegated: z.boolean(),
      })
      .strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.datastoreActivity, activityId: A.datastoreActivity.read },
  },
  /** Отказ в раскрытии (нет права, окно подтверждения закрыто, квота, пауза детекции) — свёрткой по часу */
  'pii.reveal_denied': {
    category: 'pii',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z
      .object({
        recordType: detailCode(64),
        fields: revealFields,
        reason: detailCode(32),
        attempts: detailCount(),
      })
      .strict(),
    vocab: 'authz_fail',
    ocsf: { classUid: C.datastoreActivity, activityId: A.datastoreActivity.read },
  },
});
