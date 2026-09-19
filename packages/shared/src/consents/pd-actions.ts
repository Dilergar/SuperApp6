// ============================================================
// Учёт действий с ПДн и журнал инцидентов
// ============================================================
// Правила защиты ПДн № 179/НҚ п. 9 пп. 5: оператор регистрирует и учитывает действия по
// пп. 3–6 п. 4 ст. 8 ЗоПД — срок согласия, передача третьим лицам, трансграничная
// передача, распространение в общедоступных источниках.

export const PD_ACTION_TYPES = [
  /** Передача третьему лицу внутри РК */
  'transfer',
  /** Трансграничная передача */
  'cross_border',
  /** Распространение в общедоступных источниках (публичная ссылка, открытая карточка) */
  'publication',
  /** Срок действия согласия: начало (приёмка) и прекращение (отзыв, удаление аккаунта) */
  'consent_term',
] as const;
export type PdActionType = (typeof PD_ACTION_TYPES)[number];

/** Назначение действия — машинный код (слова — `consents.pdPurposes.<code>` в каталоге). */
export const PD_PURPOSES = [
  'otp_sms',
  'notification_sms',
  'service_sms',
  'notification_push',
  'calendar_sync',
  'webhook_delivery',
  'signature_check',
  'share_link_created',
  'card_visibility_changed',
  'consent_accepted',
  'consent_revoked',
  'account_deletion_requested',
] as const;
export type PdPurpose = (typeof PD_PURPOSES)[number];

// ---- Инциденты (ЗоПД ст. 25 п. 2 пп. 8; Правила № 179/НҚ п. 11; Правила № 481/НҚ) ----

export const PD_INCIDENT_KINDS = ['unauthorized_access', 'leak', 'loss', 'alteration', 'availability', 'other'] as const;
export type PdIncidentKind = (typeof PD_INCIDENT_KINDS)[number];

export const PD_INCIDENT_STATUSES = ['open', 'authority_notified', 'subjects_notified', 'closed'] as const;
export type PdIncidentStatus = (typeof PD_INCIDENT_STATUSES)[number];

export const PD_INCIDENT_EVENT_TYPES = ['opened', 'authority_notified', 'subjects_notified', 'note', 'closed', 'deadline_alert'] as const;
export type PdIncidentEventType = (typeof PD_INCIDENT_EVENT_TYPES)[number];

export const PD_INCIDENT_LIMITS = {
  /** Уведомить уполномоченный орган — в течение одного рабочего дня с момента обнаружения */
  notifyBusinessDays: 1,
  /** Тревога сотрудникам безопасности за N часов до дедлайна */
  alertBeforeHours: 4,
  summaryMax: 4_000,
  scopeMax: 2_000,
} as const;

/**
 * Прибавить рабочие дни (пн–пт) к моменту времени. Праздники не учитываются НАМЕРЕННО:
 * без них срок получается раньше настоящего — ошибка в безопасную сторону. Счёт ведётся
 * в поясе платформы (UTC+5, Казахстан — единый пояс с 01.03.2024), время суток сохраняется.
 */
export function addBusinessDays(from: Date, days: number, utcOffsetHours = 5): Date {
  const shift = utcOffsetHours * 3_600_000;
  const local = new Date(from.getTime() + shift);
  let left = days;
  while (left > 0) {
    local.setUTCDate(local.getUTCDate() + 1);
    const dow = local.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(local.getTime() - shift);
}

/**
 * Полных лет на дату (обе даты — `YYYY-MM-DD` в поясе человека/платформы). Строки, а не Date:
 * «сегодня» в UTC — это вчера до 05:00 по Алматы, и день рождения сдвигался бы на сутки.
 */
export function ageOnDate(dateOfBirthIso: string, todayIso: string): number {
  const [by, bm, bd] = dateOfBirthIso.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = todayIso.slice(0, 10).split('-').map(Number);
  if (![by, bm, bd, ty, tm, td].every((n) => Number.isInteger(n))) return Number.NaN;
  let age = ty! - by!;
  if (tm! < bm! || (tm === bm && td! < bd!)) age--;
  return age;
}

/** Сегодняшняя дата `YYYY-MM-DD` в поясе платформы (UTC+5). */
export function platformTodayIso(now: Date = new Date(), utcOffsetHours = 5): string {
  return new Date(now.getTime() + utcOffsetHours * 3_600_000).toISOString().slice(0, 10);
}
