import { defineNotifications } from './types';

/**
 * Документооборот. Итог маршрута — автору; внешний контур (ЭДО) — исход у второй
 * стороны с контекстом документа (движковые sign.* для таких заявок подавлены).
 * Отказ СВОЕГО подписанта — отдельный тип: другой виновник и другой следующий шаг.
 * `ref` = документ (`org_document`).
 */
export const DOCUMENTS_NOTIFICATIONS = defineNotifications({
  'document.resolved': { service: 'documents', priority: 'high', icon: 'docs', contexts: 'workspace', collapse: 'ref' },
  'document.counterparty_signed': { service: 'documents', priority: 'high', icon: 'signature', contexts: 'workspace', collapse: 'ref' },
  'document.counterparty_declined': { service: 'documents', priority: 'high', icon: 'blocked', contexts: 'workspace', collapse: 'ref' },
  'document.internal_declined': { service: 'documents', priority: 'high', icon: 'blocked', contexts: 'workspace', collapse: 'ref' },
  'document.external_expired': { service: 'documents', priority: 'high', icon: 'hourglass', contexts: 'workspace', collapse: 'ref' },
});
