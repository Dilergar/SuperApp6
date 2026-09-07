import { defineNotifications } from './types';

/** Оргструктура: руководство отделом/объектом и замещение. */
export const STAFF_NOTIFICATIONS = defineNotifications({
  'staff.head.assigned': { service: 'staff', priority: 'high', icon: 'department', contexts: 'workspace', collapse: 'none' },
  'staff.deputy.assigned': { service: 'staff', priority: 'high', icon: 'staff', contexts: 'workspace', collapse: 'none' },
});
