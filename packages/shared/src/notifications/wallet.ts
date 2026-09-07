import { defineNotifications } from './types';

/** Кошелёк: выплата коинов при приёмке задачи. */
export const WALLET_NOTIFICATIONS = defineNotifications({
  'wallet.coins.received': { service: 'wallet', priority: 'normal', icon: 'coins', contexts: 'personal', collapse: 'none' },
});
