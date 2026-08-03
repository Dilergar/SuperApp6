import { z } from 'zod';

// ============================================
// Общие кирпичи разбора СТРОКИ ЗАПРОСА
// ============================================

/**
 * Флаг в query-строке: `?archived=false` обязан значить ЛОЖЬ.
 *
 * `z.coerce.boolean()` для этого не годится и является ловушкой: coerce делает
 * обычный `Boolean(value)`, а строка `'false'` — непустая, то есть истинная.
 * Ручка молча начинает отвечать ровно наоборот, и заметить это можно только
 * глазами (так «Мои заявки» показывали архив вместо активных заявок).
 *
 * Принимаем то, что реально шлют клиенты: `true/false`, `1/0`, `yes/no`.
 * Пустая строка (`?flag=`) — это «параметр не задан», а не «истина».
 */
export const queryBoolean = z
  .union([z.boolean(), z.string()])
  .transform((v, ctx) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    if (s === '' ) return undefined;
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ожидается true или false' });
    return z.NEVER;
  });
