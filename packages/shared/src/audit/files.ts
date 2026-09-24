import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode } from './types';

// ============================================================
// Файлы: угрозы в загруженном (core/files, сканер ClamAV)
// ============================================================
// Вердикт сканера и событие — одной транзакцией: выдача файла блокируется тем же фактом.
// Видят загрузивший (уведомление — паспортом `notify`), организация, если файл её, и
// платформа (серия заражённых загрузок одним актором — `detect.malware_burst`).
// Имя файла — снимок подписи цели (`target.label`), не деталь.

export const FILES_AUDIT_EVENTS = defineAuditEvents({
  'files.malware_detected': {
    category: 'files',
    severity: 'high',
    visibility: AUDIT_VIS.both,
    notify: 'files.scan.infected',
    details: z.object({ engine: z.enum(['clamav']), signature: detailCode(128) }).strict(),
    vocab: 'upload_validation',
    ocsf: { classUid: C.detectionFinding, activityId: A.detectionFinding.create },
  },
});
