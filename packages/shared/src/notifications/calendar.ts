import { defineNotifications } from './types';

/** Календарь. `ref` = событие (`event`) или ресурс. RSVP схлопывается: «Асель и ещё 4 ответили». */
export const CALENDAR_NOTIFICATIONS = defineNotifications({
  'calendar.event.invited': { service: 'calendar', priority: 'high', icon: 'calendarAdd', contexts: 'both', collapse: 'ref' },
  'calendar.event.reminder': { service: 'calendar', priority: 'high', icon: 'bellRinging', contexts: 'both', collapse: 'ref', ttlSec: 3600 },
  'calendar.event.rsvp': { service: 'calendar', priority: 'normal', icon: 'mail', contexts: 'both', collapse: 'ref' },
  'calendar.event.updated': { service: 'calendar', priority: 'high', icon: 'edit', contexts: 'both', collapse: 'ref' },
  'calendar.event.cancelled': { service: 'calendar', priority: 'high', icon: 'blocked', contexts: 'both', collapse: 'ref' },
  'calendar.resource.requested': { service: 'calendar', priority: 'high', icon: 'calendar', contexts: 'both', collapse: 'ref' },
  'calendar.resource.confirmed': { service: 'calendar', priority: 'high', icon: 'calendarCheck', contexts: 'both', collapse: 'ref' },
  'calendar.resource.rejected': { service: 'calendar', priority: 'high', icon: 'blocked', contexts: 'both', collapse: 'ref' },
});
