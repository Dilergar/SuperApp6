import { z } from 'zod';
import { SEARCH_LIMITS, SEARCH_SOURCE_TYPES } from '../constants/search';

const noHtml = (s: string) => !/[<>]/.test(s);

/**
 * Search query.
 * - No `type`/`chatId` → GLOBAL grouped search (Чаты / Люди / Сообщения), few each.
 * - `type` (single source) → a flat, cursor-paginated page of that type.
 * - `chatId` → in-chat message search (paginated), implies type=message.
 */
export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .min(SEARCH_LIMITS.minQueryLength, 'Слишком короткий запрос')
      .max(SEARCH_LIMITS.maxQueryLength)
      .refine(noHtml, 'Недопустимые символы'),
    type: z.enum(SEARCH_SOURCE_TYPES).optional(),
    chatId: z.string().uuid().optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
