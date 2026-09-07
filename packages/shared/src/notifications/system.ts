import { defineNotifications } from './types';

/** Платформа: приветствие и объявления (массовый фанаут чанками по 500). */
export const SYSTEM_NOTIFICATIONS = defineNotifications({
  'system.welcome': { service: 'system', priority: 'low', icon: 'smiley', contexts: 'both', collapse: 'none' },
  'system.announcement': { service: 'system', priority: 'normal', icon: 'broadcast', contexts: 'both', collapse: 'none' },
});
