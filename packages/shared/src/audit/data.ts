import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_EXPORT_FORMATS, AUDIT_EXPORT_SOURCES, AUDIT_VIS, defineAuditEvents, detailCount } from './types';

/** Форматы в следе выгрузки: журнал организации (ndjson/csv) и архив данных целиком (zip, core/lifecycle). */
const DATA_EXPORT_FORMATS = [...AUDIT_EXPORT_FORMATS, 'zip'] as const;

// ============================================================
// Выгрузки данных — каждая выгрузка = эксфильтрация (GCS не отличает чтение от выноса)
// ============================================================
// `read ≠ download ≠ export`: выгрузка пишет след всегда и на любом тарифе (полнота журнала
// от тарифа не зависит). Источник — закрытый словарь; строк — счётчик, для детекции
// массового выноса (`detect.mass_export`). Человек видит свою выгрузку «Мои данные»,
// организация — свои выгрузки (КЭДО, документы, журнал).

export const DATA_AUDIT_EVENTS = defineAuditEvents({
  'data.export': {
    category: 'data',
    severity: 'high',
    visibility: AUDIT_VIS.both,
    details: z.object({ source: z.enum(AUDIT_EXPORT_SOURCES), rows: detailCount(), format: z.enum(DATA_EXPORT_FORMATS).optional() }).strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.export },
    subjectFrom: 'actor',
  },
});
