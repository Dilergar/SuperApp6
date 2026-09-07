import { defineNotifications } from './types';

/**
 * Электронная подпись (core/sign). Отдельные типы, а не approval.*: подпись —
 * юридическое действие, в ленте человек должен видеть «подпишите», а не «решите».
 * «Подпишите» — критично: неотключаемо, пробивает тишину, кандидат на SMS.
 * `ref` = заявка на подпись (`sign_request`).
 */
export const SIGN_NOTIFICATIONS = defineNotifications({
  'sign.requested': { service: 'sign', priority: 'critical', icon: 'signature', contexts: 'both', collapse: 'ref', smsEligible: true },
  'sign.completed': { service: 'sign', priority: 'high', icon: 'sealCheck', contexts: 'both', collapse: 'ref' },
  'sign.declined': { service: 'sign', priority: 'high', icon: 'blocked', contexts: 'both', collapse: 'ref' },
});
