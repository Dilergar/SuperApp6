import { defineNotifications } from './types';

/**
 * Кабинет платформы (core/platform). Адресаты — сотрудники платформы (все
 * `platform_owner` у security-alert). Личный контекст: кабинет — не организация.
 */
export const PLATFORM_NOTIFICATIONS = defineNotifications({
  // Критичное событие безопасности кабинета: добавлен сотрудник, выдана/снята роль,
  // изменена политика, раскрытий PII сверх порога, серия отказов
  'platform.security.alert': { service: 'platform', priority: 'critical', icon: 'shield', contexts: 'personal', collapse: 'none', smsEligible: true },
  // Four-eyes: заявка ждёт решения второго сотрудника / решена
  'platform.request.pending': { service: 'platform', priority: 'high', icon: 'pending', contexts: 'personal', collapse: 'ref' },
  'platform.request.resolved': { service: 'platform', priority: 'high', icon: 'checkCircle', contexts: 'personal', collapse: 'ref' },
});
