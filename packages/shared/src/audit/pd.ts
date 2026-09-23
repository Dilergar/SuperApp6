import { z } from 'zod';
import { PD_BASES, PD_FIELD_CODES, PD_RECIPIENT_KEYS, type PdRecipientKey } from '../consents/recipients';
import { PD_PURPOSES } from '../consents/pd-actions';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCountry } from './types';

// ============================================================
// Учёт действий с ПДн (Правила № 179/НҚ п. 9 пп. 5; бывший `pd_action_records`)
// ============================================================
// Передача третьему лицу, трансграничная передача, распространение. Пишется В МЕСТЕ
// ФАКТИЧЕСКОЙ ПЕРЕДАЧИ (SMS, push, Google, вебхук, публичная ссылка). Окно ленты
// человека эти события не режет (`windowExempt`): «Мои данные» показывает всю историю.
// Срок согласия (`consent_term`) — события `consents.accepted|revoked`.

const basis = z.enum(PD_BASES);
const recipient = z.enum(PD_RECIPIENT_KEYS as [PdRecipientKey, ...PdRecipientKey[]]);

const pdDetails = z
  .object({
    recipient: recipient.nullable().optional(),
    recipientCountry: detailCountry().nullable().optional(),
    basis,
    fields: z.array(z.enum(PD_FIELD_CODES)).max(32),
    purpose: z.enum(PD_PURPOSES),
    crossBorder: z.boolean(),
  })
  .strict();

export const PD_AUDIT_EVENTS = defineAuditEvents({
  'pd.transfer': {
    category: 'pd',
    severity: 'info',
    visibility: AUDIT_VIS.subject,
    details: pdDetails,
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.share },
    windowExempt: true,
  },
  'pd.cross_border': {
    category: 'pd',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: pdDetails,
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.share },
    windowExempt: true,
  },
  'pd.publication': {
    category: 'pd',
    severity: 'low',
    visibility: AUDIT_VIS.subject,
    details: pdDetails,
    vocab: 'sensitive_update',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.share },
    windowExempt: true,
  },
});
