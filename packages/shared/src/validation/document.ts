import { z } from 'zod';
import { DOCS_LIMITS, DOCUMENT_USER_MODES } from '../constants/documents';

// ============================================
// Docs Engine — Zod-схемы
// ============================================

// Название едет в имя файла-снимка, в BaseFileName редактора и в плашки чатов —
// угловые скобки в пользовательском тексте платформа не пропускает нигде.
const title = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(DOCS_LIMITS.maxTitleLength)
  .refine((s) => !/[<>]/.test(s), 'Недопустимые символы');

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
    // Только edit|readonly: `locked` ставит внешняя система, и владелец не должен
    // уметь снять её со своего документа, пока тот на согласовании.
    mode: z.enum(DOCUMENT_USER_MODES).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.mode !== undefined, { message: 'Нечего обновлять' });

/**
 * POST /docs/:id/versions — «Сохранить версию» вручную (pre_sign — задел под ЭЦП).
 * Место обязательно принимать и здесь: право на эти действия считается ровно так же,
 * как право на правку, а оно наследуется от места. Без него участник задачи, который
 * прямо сейчас правит документ, получал бы на свою же кнопку 403.
 */
export const documentVersionCreateSchema = z
  .object({
    reason: z.enum(['manual', 'pre_sign']).default('manual'),
    refType: refType.optional(),
    refId: refId.optional(),
  })
  .strict()
  .refine(bothOrNeither, bothOrNeitherMsg);

/** POST /docs/:id/versions/:versionId/restore — вернуть веху как текущее содержимое */
export const documentRestoreSchema = z
  .object({
    refType: refType.optional(),
    refId: refId.optional(),
  })
  .strict()
  .refine(bothOrNeither, bothOrNeitherMsg);

/** POST /docs/:id/rendition — заказать ленивую производную (PDF-отпечаток / текст для ИИ) */
export const documentRenditionSchema = z
  .object({
    target: z.enum(['pdf', 'text']).default('pdf'),
    refType: refType.optional(),
    refId: refId.optional(),
  })
  .strict()
  .refine(bothOrNeither, bothOrNeitherMsg);

export type DocumentFromFileInput = z.infer<typeof documentFromFileSchema>;
export type DocumentOpenInput = z.infer<typeof documentOpenSchema>;
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;
export type DocumentVersionCreateInput = z.infer<typeof documentVersionCreateSchema>;
