import { defineNotifications } from './types';

/**
 * Безопасность аккаунта: смена пароля/номера (core/verify, core/users), заражённый
 * файл (core/files). Критично — неотключаемо. SMS о смене пароля — по opt-in
 * (уйдёт на текущий номер); о смене номера — нет: номер только что сменился.
 */
export const SECURITY_NOTIFICATIONS = defineNotifications({
  'auth.password.changed': { service: 'security', priority: 'critical', icon: 'lock', contexts: 'personal', collapse: 'none', smsEligible: true },
  'auth.phone.changed': { service: 'security', priority: 'critical', icon: 'device', contexts: 'personal', collapse: 'none' },
  'files.scan.infected': { service: 'security', priority: 'critical', icon: 'shield', contexts: 'personal', collapse: 'none' },
});
