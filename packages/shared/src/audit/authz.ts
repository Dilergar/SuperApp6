import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCode, detailCount } from './types';

// ============================================================
// Отказы доступа (403): попытка открыть чужое — главный след перебора чужих id
// ============================================================
// Свёртка, а не строка на отказ (AWS CloudTrail `AccessDenied`, GCP Policy Denied): одна
// строка на (актор, шаблон маршрута) за час на счётчиках 1, 10, 100… с полем `attempts`.
// Только платформе: человеку и организации это шум, а показ отказа чужой организации
// подсказал бы, что объект существует. Отказы-состояния (свежая сессия, шлюз согласий,
// заморозка) не считаются — `AUDIT_AUTHZ_IGNORED_CODES`. Перебор разных объектов —
// детекция `detect.idor_probing`.

export const AUTHZ_AUDIT_EVENTS = defineAuditEvents({
  'authz.denied': {
    category: 'authz',
    severity: 'low',
    visibility: AUDIT_VIS.platform,
    /** `reason` — машинный код отказа (`details.code` конверта ошибки) */
    details: z.object({ reason: detailCode(80), attempts: detailCount() }).strict(),
    vocab: 'authz_fail',
    ocsf: { classUid: C.apiActivity, activityId: A.apiActivity.other },
    subjectFrom: 'actor',
  },
});
