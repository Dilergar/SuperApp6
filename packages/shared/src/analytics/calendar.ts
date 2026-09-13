import { z } from 'zod';
import { defineAnalyticsEvents } from './types';

// ============================================================
// Календарь — факты сервера
// ============================================================

export const CALENDAR_ANALYTICS_EVENTS = defineAnalyticsEvents({
  'calendar.event.created': {
    service: 'calendar',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z
      .object({
        allDay: z.boolean(),
        hasParticipants: z.boolean(),
        recurring: z.boolean(),
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  'calendar.event.rsvp': {
    service: 'calendar',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ status: z.enum(['pending', 'accepted', 'declined', 'tentative']) }).strict(),
    version: 1,
    status: 'live',
  },
});
