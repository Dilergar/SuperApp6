import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount } from './types';

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
});
