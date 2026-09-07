import { defineNotifications } from './types';

/** Финансы B2C: лимиты, долги, повторяющиеся операции, шеринг книги. */
export const FINANCES_NOTIFICATIONS = defineNotifications({
  'finance.budget.warning': { service: 'finances', priority: 'normal', icon: 'warning', contexts: 'personal', collapse: 'ref' },
  'finance.budget.exceeded': { service: 'finances', priority: 'high', icon: 'warningCircle', contexts: 'personal', collapse: 'ref' },
  'finance.debt.payment_due': { service: 'finances', priority: 'high', icon: 'debt', contexts: 'personal', collapse: 'ref' },
  'finance.debt.paid': { service: 'finances', priority: 'normal', icon: 'checkCircle', contexts: 'personal', collapse: 'ref' },
  'finance.recurring.due': { service: 'finances', priority: 'high', icon: 'replay', contexts: 'personal', collapse: 'ref' },
  // Автозапись — FYI: только in-app и схлопнуто по правилу
  'finance.recurring.recorded': { service: 'finances', priority: 'low', icon: 'refresh', contexts: 'personal', collapse: 'ref' },
  'finance.book.shared': { service: 'finances', priority: 'high', icon: 'share', contexts: 'personal', collapse: 'none' },
});
