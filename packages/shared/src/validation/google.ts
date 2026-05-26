import { z } from 'zod';

/** `__new__` creates a dedicated SuperApp6 calendar; otherwise an existing Google calendar id. */
export const selectGoogleCalendarSchema = z.object({
  calendarId: z.string().min(1).max(256),
});
