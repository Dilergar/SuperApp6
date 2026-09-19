import { defineNotifications } from './types';

/**
 * Согласия и документы платформы (core/consents). Адресатов решает продюсер:
 * новая версия документа человека — всем живым аккаунтам (фанаут джобом, порциями);
 * новая версия условий для организаций — владельцу и админам (роль, не человек);
 * квитанция о принятии — самому человеку (доказательство на его стороне);
 * запрос удаления аккаунта — владельцу аккаунта (защита от угона сессии: критично, SMS).
 */
export const CONSENTS_NOTIFICATIONS = defineNotifications({
  'consents.newVersion': { service: 'consents', priority: 'high', icon: 'docs', contexts: 'personal', collapse: 'type' },
  'consents.workspace.newVersion': { service: 'consents', priority: 'high', icon: 'docs', contexts: 'workspace', collapse: 'type' },
  'consents.accepted': { service: 'consents', priority: 'normal', icon: 'sealCheck', contexts: 'both', collapse: 'none' },
  'account.deletionScheduled': { service: 'consents', priority: 'critical', icon: 'shield', contexts: 'personal', collapse: 'none', smsEligible: true },
});
