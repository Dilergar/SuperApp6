import { z } from 'zod';
import { MESSENGER_LIMITS } from '../constants/messenger';

const noHtml = (s: string) => !/[<>]/.test(s);

/** Schedule a message ("Напомнить"). `sendAt` ISO — server checks future + within horizon. */
export const scheduleMessageSchema = z
  .object({
    content: z
      .string()
      .min(1, 'validation.scheduled.messageEmpty')
      .max(MESSENGER_LIMITS.maxMessageLength)
      .refine(noHtml, 'validation.scheduled.badCharacters'),
    sendAt: z.string().datetime({ offset: true }),
    replyToId: z.string().uuid().optional(),
  })
  .strict();

export const updateScheduledMessageSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(MESSENGER_LIMITS.maxMessageLength)
      .refine(noHtml, 'validation.scheduled.badCharacters')
      .optional(),
    sendAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((v) => v.content !== undefined || v.sendAt !== undefined, 'validation.scheduled.nothingToUpdate');

export type ScheduleMessageInput = z.infer<typeof scheduleMessageSchema>;
export type UpdateScheduledMessageInput = z.infer<typeof updateScheduledMessageSchema>;
