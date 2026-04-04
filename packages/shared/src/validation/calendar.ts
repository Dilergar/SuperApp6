import { z } from 'zod';

const calendarEventTypeEnum = z.enum(['event', 'task', 'reminder', 'birthday']);

export const createCalendarEventSchema = z.object({
  title: z.string().min(1, 'Название события обязательно').max(500),
  description: z.string().max(5000).optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  allDay: z.boolean().optional().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  type: calendarEventTypeEnum.optional().default('event'),
  recurrenceRule: z.string().max(500).optional(),
  taskId: z.string().uuid().optional(),
});

export const updateCalendarEventSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  allDay: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  recurrenceRule: z.string().max(500).nullable().optional(),
});

export const calendarFilterSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  types: z.array(calendarEventTypeEnum).optional(),
  includeShared: z.boolean().optional().default(true),
});

export const shareCalendarSchema = z.object({
  sharedWithUserId: z.string().uuid(),
  permission: z.enum(['view', 'edit']),
});
