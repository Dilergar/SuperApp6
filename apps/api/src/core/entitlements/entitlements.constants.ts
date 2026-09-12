/**
 * Константы движка core/entitlements: типы джобов, ключи Redis, темы шины.
 * Живут у владельца (движка): их ставят и сам движок, и его крон.
 */
export const ENTITLEMENT_JOBS = {
  /** Будильник срока: подписка (trialEndsAt / currentPeriodEnd / graceUntil) или грант (validUntil) */
  expiry: 'entitlements.expiry',
} as const;

export const ENTITLEMENT_BUS_EVENTS = {
  /** `{subjectType, subjectId}` — снимок субъекта изменился (at-most-once: клиент перечитывает) */
  changed: 'entitlements.changed',
} as const;

/** Ключи Redis: эпохи ОТДЕЛЬНЫ от core/access (оплата не сбрасывает права всей платформы). */
export const ENTITLEMENT_REDIS = {
  catalogEpoch: 'ent:catalog',
  subjectEpoch: (subjectType: string, subjectId: string) => `ent:epoch:${subjectType}:${subjectId}`,
  snapshot: (catalogEpoch: string, subjectType: string, subjectId: string, subjectEpoch: string) =>
    `ent:snap:${catalogEpoch}:${subjectType}:${subjectId}:${subjectEpoch}`,
} as const;

/** TTL снимка субъекта в Redis (секунд); реальный TTL = min(это, срок ближайшего изменения). */
export const ENTITLEMENT_SNAPSHOT_TTL_SEC = 300;

/** Порог уведомления «квота почти исчерпана» */
export const ENTITLEMENT_QUOTA_WARN_RATIO = 0.8;

/** За сколько дней до конца пробного периода предупреждать (по убыванию) */
export const TRIAL_ENDING_WARN_DAYS = [7, 1] as const;

/** Тип объекта уведомлений движка (deep link на «Тариф и лимиты»); refId = `<subjectType>:<subjectId>` */
export const ENTITLEMENT_NOTIFICATION_REF_TYPE = 'entitlement';
