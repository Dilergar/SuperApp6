import { z } from 'zod';

/** `__new__` creates a dedicated SuperApp6 calendar; otherwise an existing Google calendar id. */
export const selectGoogleCalendarSchema = z.object({
  calendarId: z.string().min(1).max(256),
});

// ---- Входные типы: ЕДИНСТВЕННОЕ описание формы входа ----
// Рукописные интерфейсы в types/*.ts удалены: два независимых описания одного
// входа расходятся молча (Zod уходил вперёд, интерфейс врал).
export type SelectGoogleCalendarInput = z.infer<typeof selectGoogleCalendarSchema>;
