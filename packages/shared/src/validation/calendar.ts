import { z } from 'zod';

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Цвет должен быть в формате #RRGGBB');

const visibilityEnum = z.enum(['inherit', 'busy', 'hidden']);

// Safe RRULE subset (validated structurally here; parsed by rrule.js server-side).
const rruleSchema = z
  .string()
  .max(500)
  .regex(
    /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL=\d{1,3}|COUNT=\d{1,4}|UNTIL=\d{8}(T\d{6}Z?)?|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|BYMONTHDAY=-?\d{1,2}(,-?\d{1,2})*|BYMONTH=\d{1,2}))*$/,
    'Недопустимое правило повторения',
  );

const reminderOffsets = z
  .array(z.number().int().min(0).max(40320)) // up to 4 weeks before
  .max(5, 'Не больше 5 напоминаний')
  .refine((arr) => new Set(arr).size === arr.length, 'Напоминания не должны повторяться');

const editScopeEnum = z.enum(['this', 'this_and_following', 'all']);

export const createCalendarEventSchema = z
  .object({
    title: z.string().min(1, 'Название события обязательно').max(500),
    description: z.string().max(5000).optional(),
    location: z.string().max(500).optional(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    allDay: z.boolean().optional().default(false),
    color: hexColor.optional(),
    visibility: visibilityEnum.optional().default('inherit'),
    reminderOffsets: reminderOffsets.optional(),
    recurrenceRule: rruleSchema.optional(),
    participantUserIds: z.array(z.string().uuid()).max(200).optional(),
    participantCircleId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
  })
  .refine((d) => new Date(d.endTime) >= new Date(d.startTime), {
    message: 'Окончание не может быть раньше начала',
    path: ['endTime'],
  });

export const updateCalendarEventSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).nullable().optional(),
    location: z.string().max(500).nullable().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    allDay: z.boolean().optional(),
    color: hexColor.nullable().optional(),
    visibility: visibilityEnum.optional(),
    reminderOffsets: reminderOffsets.optional(),
    recurrenceRule: rruleSchema.nullable().optional(),
    resourceId: z.string().uuid().nullable().optional(),
    editScope: editScopeEnum.optional().default('all'),
    occurrenceStart: z.string().datetime().optional(),
  })
  .refine(
    (d) =>
      d.editScope === 'all' ||
      d.editScope === undefined ||
      d.occurrenceStart !== undefined,
    { message: 'Для правки экземпляра нужен occurrenceStart', path: ['occurrenceStart'] },
  );

export const deleteCalendarEventSchema = z.object({
  editScope: editScopeEnum.optional().default('all'),
  occurrenceStart: z.string().datetime().optional(),
});

export const calendarRangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  layers: z.array(z.enum(['events', 'tasks', 'finance'])).optional(),
  /** people whose calendars to overlay as layers (must have shared with the viewer). */
  include: z.array(z.string().uuid()).max(50).optional(),
});

/** Set the caller's own reminder offsets on an event (organizer or participant). */
export const myRemindersSchema = z.object({
  offsets: z.array(z.number().int().min(0).max(40320)).max(5),
});

// ---- Phase 2 (social) ----

export const inviteParticipantsSchema = z
  .object({
    userIds: z.array(z.string().uuid()).max(200).optional(),
    circleId: z.string().uuid().optional(),
  })
  .refine((d) => (d.userIds?.length ?? 0) > 0 || !!d.circleId, {
    message: 'Укажите людей или группу',
  });

export const rsvpSchema = z.object({
  status: z.enum(['accepted', 'declined', 'tentative']),
});

/** Person-level calendar share. 'none' = remove the share (no row), so only busy|detailed here. */
export const setCalendarShareSchema = z.object({
  sharedWithUserId: z.string().uuid(),
  accessLevel: z.enum(['busy', 'detailed']),
});

export const smartMatchSchema = z
  .object({
    userIds: z.array(z.string().uuid()).min(1).max(50),
    durationMin: z.number().int().min(15).max(1440),
    from: z.string().datetime(),
    to: z.string().datetime(),
    dayStartMin: z.number().int().min(0).max(1440).optional(),
    dayEndMin: z.number().int().min(0).max(1440).optional(),
  })
  .refine((d) => new Date(d.to) > new Date(d.from), {
    message: 'Конец периода должен быть позже начала',
    path: ['to'],
  });

// ---- Phase 3 (resources) ----

const resourceTypeEnum = z.enum(['room', 'vehicle', 'equipment', 'other']);

export const createResourceSchema = z.object({
  name: z.string().min(1, 'Название ресурса обязательно').max(120),
  type: resourceTypeEnum.optional().default('other'),
  capacity: z.number().int().min(1).max(1000).optional().default(1),
  bookerUserIds: z.array(z.string().uuid()).max(500).optional(),
  bookerCircleIds: z.array(z.string().uuid()).max(100).optional(),
});

export const updateResourceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: resourceTypeEnum.optional(),
  capacity: z.number().int().min(1).max(1000).optional(),
  bookerUserIds: z.array(z.string().uuid()).max(500).optional(),
  bookerCircleIds: z.array(z.string().uuid()).max(100).optional(),
});
