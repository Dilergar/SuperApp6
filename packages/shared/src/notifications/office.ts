import { defineNotifications } from './types';

/** Виртуальный офис: видеовстречи. `ref` = комната (`office_room`). */
export const OFFICE_NOTIFICATIONS = defineNotifications({
  'office.meeting.invited': { service: 'office', priority: 'high', icon: 'video', contexts: 'workspace', collapse: 'ref' },
});
