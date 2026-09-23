import { z } from 'zod';
import { CONSENT_REVOKE_REASONS } from '../consents/registry';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount } from './types';

// ============================================================
// Срок согласия (Правила № 179/НҚ п. 9 пп. 5: учёт начала и прекращения согласия)
// ============================================================
// Приёмка и отзыв согласия — события журнала; САМО доказательство (текст версии, хэш,
// IP/UA под платформенным ключом) остаётся в `consent_acceptances`. Субъект — человек
// либо организация (тогда `workspace_id`, без субъекта-человека). Окно ленты не режет.

export const CONSENTS_AUDIT_EVENTS = defineAuditEvents({
  'consents.accepted': {
    category: 'consents',
    severity: 'info',
    visibility: AUDIT_VIS.both,
    details: z.object({ document: detailCode(48), version: detailCount() }).strict(),
    vocab: 'sensitive_create',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.attachPolicy },
    windowExempt: true,
  },
  'consents.revoked': {
    category: 'consents',
    severity: 'low',
    visibility: AUDIT_VIS.both,
    details: z.object({ document: detailCode(48), reason: z.enum(CONSENT_REVOKE_REASONS) }).strict(),
    vocab: 'sensitive_delete',
    ocsf: { classUid: C.accountChange, activityId: A.accountChange.detachPolicy },
    windowExempt: true,
  },
});
