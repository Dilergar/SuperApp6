import { z } from 'zod';
import { DOCS_LIMITS, DOCUMENT_MODES } from '../constants/documents';

// ============================================
// Docs Engine — Zod-схемы
// ============================================

const title = z.string().trim().min(1, 'Название обязательно').max(DOCS_LIMITS.maxTitleLength);

/**
 * Место, откуда человек пришёл к документу (кнопка на вложении задачи/чата). ПРАВКА
 * наследуется только от него — объединение по всем привязкам оставлено для просмотра,
 * иначе «дал ссылку в свой чат» тихо раздавал бы право менять чужой документ.
 */
const refType = z.string().trim().min(1).max(40);
const refId = z.string().trim().min(1).max(64);

const bothOrNeither = (v: { refType?: string; refId?: string }) => !!v.refType === !!v.refId;
const bothOrNeitherMsg = { message: 'refType и refId задаются вместе' };

/** POST /docs/from-file — оживить загруженный файл в документ (ЯВНЫЙ акт человека, п.9) */
export const documentFromFileSchema = z
  .object({
    fileId: z.string().uuid(),
    title: title.optional(),
    refType: refType.optional(),
    refId: refId.optional(),
  })
  .strict()
  .refine(bothOrNeither, bothOrNeitherMsg);

/** POST /docs/:id/open — запуск редактора */
export const documentOpenSchema = z
  .object({
    refType: refType.optional(),
    refId: refId.optional(),
    /** Кнопка «Открыть» (просмотр) вместо «Редактировать» — потолок прав, не повышение */
    readonly: z.boolean().optional(),
  })
  .strict()
  .refine(bothOrNeither, bothOrNeitherMsg);

/** PATCH /docs/:id — владелец: переименовать и/или перевести в «только чтение» */
export const documentUpdateSchema = z
  .object({
    title: title.optional(),
    mode: z.enum(DOCUMENT_MODES).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.mode !== undefined, { message: 'Нечего обновлять' });

/** POST /docs/:id/versions — «Сохранить версию» вручную (pre_sign — задел под ЭЦП) */
export const documentVersionCreateSchema = z
  .object({
    reason: z.enum(['manual', 'pre_sign']).default('manual'),
  })
  .strict();

/** POST /docs/:id/rendition — заказать ленивую производную (PDF-отпечаток / текст для ИИ) */
export const documentRenditionSchema = z
  .object({ target: z.enum(['pdf', 'text']).default('pdf') })
  .strict();

export type DocumentFromFileInput = z.infer<typeof documentFromFileSchema>;
export type DocumentOpenInput = z.infer<typeof documentOpenSchema>;
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;
export type DocumentVersionCreateInput = z.infer<typeof documentVersionCreateSchema>;
