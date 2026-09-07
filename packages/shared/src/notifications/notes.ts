import { defineNotifications } from './types';

/** Заметки: доступ к заметке или папке. `ref` = заметка (`note`). */
export const NOTES_NOTIFICATIONS = defineNotifications({
  'note.shared': { service: 'notes', priority: 'high', icon: 'notes', contexts: 'both', collapse: 'none' },
});
