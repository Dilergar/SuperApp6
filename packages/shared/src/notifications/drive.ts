import { defineNotifications } from './types';

/** Диск (OmniDrive): доступ к папке или файлу. `ref` = узел Диска (`drive_node`). */
export const DRIVE_NOTIFICATIONS = defineNotifications({
  'drive.shared': { service: 'drive', priority: 'high', icon: 'drive', contexts: 'both', collapse: 'none' },
});
