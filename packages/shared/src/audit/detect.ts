import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import { AUDIT_VIS, defineAuditEvents, detailCount, noDetails, type AuditEventDef, type AuditSeverity } from './types';

// ============================================================
// Детекции (core/audit: audit.detections.ts) — каждая тревога = строка `security_alerts`
// + событие `detect.*` (+ при CRITICAL — `platform.security.alert` сотрудникам безопасности).
// Автоматическая реакция (блокировка, заморозка) пишет своё событие с `ref` на причину.
// ============================================================
// Новое устройство/страна — НЕ тревога, а уведомление человеку: `auth.session.new_device|new_country`.

/** Сводка тревоги: сколько событий-улик, сколько аккаунтов/адресов задето. */
const finding = z
  .object({
    events: detailCount(),
    accounts: detailCount().optional(),
    networks: detailCount().optional(),
    rows: detailCount().optional(),
    windowMin: detailCount(),
    failureRatePct: detailCount().optional(),
  })
  .strict();

const detect = (severity: AuditSeverity, visibility: AuditEventDef['visibility'] = AUDIT_VIS.platform) =>
  ({
    category: 'detect',
    severity,
    visibility,
    details: finding,
    ocsf: { classUid: C.detectionFinding, activityId: A.detectionFinding.create },
  }) as const satisfies AuditEventDef;

export const DETECT_AUDIT_EVENTS = defineAuditEvents({
  /** Перебор паролей одного аккаунта (сверх блокировки: 15 неудач за окно) */
  'detect.bruteforce_account': detect('high'),
  /** Перебор с одной сети (30 неудач / 10 мин; мобильные ASN — ×10 при GeoIP) */
  'detect.bruteforce_ip': detect('high'),
  /** Распыление: ≥ 20 разных аккаунтов с одной сети за час */
  'detect.password_spray': detect('critical'),
  /** Подстановка учётных данных: доля неудач > 40 % при > 100 входов/мин */
  'detect.credential_stuffing': detect('critical'),
  /** Бомбардировка кодами: ≥ 5 запросов OTP за 5 мин на один аккаунт */
  'detect.otp_fatigue': detect('high', AUDIT_VIS.subject),
  /** Массовый вынос: > 1000 строк ПДн за 10 мин одним актором — видит и организация */
  'detect.mass_export': detect('high', AUDIT_VIS.workspace),
  /** Первый вход после 180 дней тишины */
  'detect.dormant_login': detect('medium'),
  /** Проверка подписанных дайджестов: строки журнала изменены или пропали */
  'detect.digest_mismatch': detect('critical'),
  /** Журнал деградировал: отказы записи best-effort сверх порога, выгрузка партиции не удалась */
  'detect.audit_degraded': {
    category: 'detect',
    severity: 'critical',
    visibility: AUDIT_VIS.platform,
    details: z.object({ failures: detailCount(), windowMin: detailCount() }).strict(),
    ocsf: { classUid: C.detectionFinding, activityId: A.detectionFinding.create },
  },
  /** Две точки входа, между которыми не успеть доехать — нужен GeoIP с городом */
  'detect.impossible_travel': { ...detect('high', AUDIT_VIS.subject), vocab: 'authn_impossible_travel', status: 'planned' },
  /** Сессия сменила сеть/устройство посреди жизни — нужен GeoIP с ASN/anonymizer */
  'detect.session_context_changed': { ...detect('high', AUDIT_VIS.subject), details: noDetails(), status: 'planned' },
});
