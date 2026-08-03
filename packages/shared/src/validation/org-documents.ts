import { z } from 'zod';
import { DOC_CATEGORIES, DOC_FIELD_KINDS, DOC_LIMITS, DOC_VISIBILITIES } from '../constants/org-documents';

// ============================================================
// Сервис «Документы» — Zod. Тонкий контроллер: parse → сервис (AI-ready, Принцип 4).
// ============================================================

const safeText = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v), { message: 'Символы < и > запрещены' });

const categoryEnum = z.enum(DOC_CATEGORIES.map((c) => c.value) as [string, ...string[]]);
const visibilityEnum = z.enum(DOC_VISIBILITIES.map((v) => v.value) as [string, ...string[]]);
const fieldKindEnum = z.enum(DOC_FIELD_KINDS.map((k) => k.value) as [string, ...string[]]);

/** Ключ поля формы = имя тега в шаблоне ({Дней}), поэтому без точек и фигурных скобок */
const fieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((v) => !/[{}.<>|]/.test(v), { message: 'В ключе поля нельзя использовать { } . | < >' });

export const docFormFieldSchema = z.object({
  key: fieldKeySchema,
  label: safeText(120),
  kind: fieldKindEnum,
  required: z.boolean().optional(),
  placeholder: safeText(120).optional(),
  options: z
    .array(z.object({ value: safeText(60), label: safeText(120) }))
    .max(50)
    .optional(),
});

export const createDocTypeSchema = z.object({
  name: safeText(DOC_LIMITS.maxNameLength),
  category: categoryEnum.optional(),
  numberFormat: safeText(DOC_LIMITS.maxNumberFormatLength).nullable().optional(),
  visibility: visibilityEnum.optional(),
  toPersonalFile: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const updateDocTypeSchema = createDocTypeSchema.partial();

export const createDocTemplateSchema = z.object({
  docTypeId: z.string().uuid(),
  name: safeText(DOC_LIMITS.maxNameLength),
  description: safeText(500).nullable().optional(),
  /** Бланк: готовый .docx из движка файлов. Пусто — пустой бланк из библиотеки заготовок */
  fileId: z.string().uuid().optional(),
  fields: z.array(docFormFieldSchema).max(DOC_LIMITS.maxFormFields).optional(),
  selfService: z.boolean().optional(),
});

export const updateDocTemplateSchema = z.object({
  name: safeText(DOC_LIMITS.maxNameLength).optional(),
  description: safeText(500).nullable().optional(),
  fields: z.array(docFormFieldSchema).max(DOC_LIMITS.maxFormFields).optional(),
  selfService: z.boolean().optional(),
  /**
   * ПЕРВАЯ загрузка бланка из конструктора (у шаблона его ещё нет). Пока этого поля
   * в схеме не было, Zod молча срезал его из запроса: кнопка загрузки в конструкторе
   * отвечала успехом, бланк не появлялся, а файлы оставались сиротами на квоте.
   * Замена уже прикреплённого бланка — новый шаблон (у старого своя история подач).
   */
  fileId: z.string().uuid().optional(),
});

/**
 * Кому доступен бланк. Ровно четыре принципала — те, что реально существуют в
 * проекции движка прав: человек и три оси оргструктуры.
 *
 * `circle` (личная Группа) отвергнут по смыслу — шаблон живёт в организации, а не в
 * личном окружении. `workspace_role` убран как несуществующий: роль организации
 * записывается принципалом `workspace:<id>#<роль>`, отдельного типа субъекта под неё
 * нет, и грант с таким типом не совпал бы ни с кем.
 */
export const docTemplateGrantSchema = z.object({
  principalType: z.enum(['user', 'department', 'position', 'branch']),
  principalId: z.string().uuid(),
});

export const createOrgDocumentSchema = z.object({
  templateId: z.string().uuid(),
  /** Сторона документа. Пусто — сам подающий (заявление «от себя») */
  subjectUserId: z.string().uuid().optional(),
  title: safeText(DOC_LIMITS.maxTitleLength).optional(),
  fields: z.record(z.unknown()).optional(),
});

export const updateOrgDocumentSchema = z.object({
  title: safeText(DOC_LIMITS.maxTitleLength).optional(),
  fields: z.record(z.unknown()).optional(),
  subjectUserId: z.string().uuid().nullable().optional(),
});

export const listOrgDocumentsSchema = z.object({
  docTypeId: z.string().uuid().optional(),
  status: z.string().max(20).optional(),
  /** Сторона документа: «мои документы» — то, что написано ОБО МНЕ */
  subjectUserId: z.string().uuid().optional(),
  /** Автор подачи: «мои заявления» — то, что подал Я. Это разные вопросы */
  createdById: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(DOC_LIMITS.maxPageSize).default(DOC_LIMITS.pageSize),
});

export type CreateDocTypeInput = z.infer<typeof createDocTypeSchema>;
export type UpdateDocTypeInput = z.infer<typeof updateDocTypeSchema>;
export type CreateDocTemplateInput = z.infer<typeof createDocTemplateSchema>;
export type UpdateDocTemplateInput = z.infer<typeof updateDocTemplateSchema>;
export type DocTemplateGrantInput = z.infer<typeof docTemplateGrantSchema>;
export type CreateOrgDocumentInput = z.infer<typeof createOrgDocumentSchema>;
export type UpdateOrgDocumentInput = z.infer<typeof updateOrgDocumentSchema>;
export type ListOrgDocumentsInput = z.infer<typeof listOrgDocumentsSchema>;
