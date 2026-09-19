/** Джобы движка согласий (core/jobs). */
export const CONSENTS_JOBS = {
  /** Версия вступила в силу: прошлая → `superseded`, отметка активации */
  versionActivate: 'consents.version.activate',
  /** Фанаут уведомления о новой версии: порциями по курсору, себя же перезаводит */
  newVersionFanout: 'consents.version.notify',
  /** Тревога за `alertBeforeHours` до дедлайна уведомления органа об инциденте */
  incidentDeadlineAlert: 'pd.incident.deadline_alert',
} as const;

/** Очередь движка (фанаут по всем аккаунтам не должен занимать общую). */
export const CONSENTS_QUEUE = 'consents';

/** AAD envelope-шифрования доказательств приёмки (платформенный скоуп). */
export const CONSENT_ACCEPTANCE_ENTITY = 'consent_acceptance';

/** Тип ссылки уведомлений движка. */
export const CONSENT_DOCUMENT_REF_TYPE = 'consent_document';

/** Префикс подписываемой строки: смена формата манифеста = новый префикс. */
export const CONSENT_SIGNATURE_PREFIX = 'sa6-consents-v1';

/** Размер порции фанаута уведомлений о новой версии. */
export const CONSENTS_FANOUT_BATCH = 500;
