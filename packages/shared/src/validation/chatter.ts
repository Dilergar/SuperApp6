import { z } from 'zod';
import { CHATTER_CATEGORIES, CHATTER_LIMITS } from '../constants/chatter';

// ============================================
// core/chatter («Хроника записи») — Zod-схемы
// ============================================

// GET-схемы НЕ .strict(): unknown query-параметр (кэш-бастер прокси/CDN ?_=…,
// будущий флаг клиента) должен молча отбрасываться (дефолт zod strip), а не
// валить всю ленту 400 — как у остальных query-схем репо (finance/wallet).
/** GET /chatter/:refType/:refId — хроника одной записи (keyset по BigInt id) */
export const chronicleQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/, 'Некорректный курсор').optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHATTER_LIMITS.maxPageSize)
    .optional(),
});

/** GET /workspaces/:id/journal — сводный журнал организации (manager+) */
export const journalQuerySchema = chronicleQuerySchema.extend({
  category: z.enum(CHATTER_CATEGORIES).optional(),
});

export type ChronicleQueryInput = z.infer<typeof chronicleQuerySchema>;
export type JournalQueryInput = z.infer<typeof journalQuerySchema>;
