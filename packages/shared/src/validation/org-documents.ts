import { z } from 'zod';
import {
  DOC_CATEGORIES,
  DOC_FIELD_KINDS,
  DOC_LIMITS,
  DOC_SIGNATURE_LEVELS,
  DOC_VISIBILITIES,
} from '../constants/org-documents';
import { builderDocSchema } from './doc-builder';

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
  signatureLevel: z.enum(DOC_SIGNATURE_LEVELS.map((v) => v.value) as [string, ...string[]]).optional(),
  toPersonalFile: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const updateDocTypeSchema = createDocTypeSchema.partial();

export const createDocTemplateSchema = z.object({
  docTypeId: z.string().uuid(),
  name: safeText(DOC_LIMITS.maxNameLength),
  description: safeText(500).nullable().optional(),
  /** 'docx' (по умолчанию) — загруженный Word-бланк; 'builder' — блочный конструктор */
  kind: z.enum(['docx', 'builder']).optional(),
  /** Бланк: готовый .docx из движка файлов (только kind='docx') */
  fileId: z.string().uuid().optional(),
  /** Блоки конструктора (только kind='builder'); пусто — пустой лист */
  builderDoc: builderDocSchema.optional(),
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
  /** Правка блоков builder-шаблона (у docx-шаблонов отклоняется сервисом) */
  builderDoc: builderDocSchema.optional(),
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
  /** Контрагент — вторая сторона (только виды категории «С контрагентами») */
  counterpartyId: z.string().uuid().optional(),
  /** Контактное лицо контрагента — будущий внешний подписант */
  counterpartyContactId: z.string().uuid().optional(),
  title: safeText(DOC_LIMITS.maxTitleLength).optional(),
  fields: z.record(z.unknown()).optional(),
});

export const updateOrgDocumentSchema = z.object({
  title: safeText(DOC_LIMITS.maxTitleLength).optional(),
  fields: z.record(z.unknown()).optional(),
  subjectUserId: z.string().uuid().nullable().optional(),
  counterpartyId: z.string().uuid().nullable().optional(),
  counterpartyContactId: z.string().uuid().nullable().optional(),
  /** Правка тела builder-документа (у docx-документов отклоняется сервисом) */
  builderDoc: builderDocSchema.optional(),
  /**
   * Поля СВОБОДНОГО документа (без шаблона): даты и суммы вводятся календарём и
   * числом, а не строкой в тексте. У документа ПО ШАБЛОНУ форма живёт в шаблоне —
   * сервис такую правку отклоняет (иначе два источника правды об одной форме).
   */
  formFields: z.array(docFormFieldSchema).max(DOC_LIMITS.maxFormFields).optional(),
});

/**
 * Свободный документ «с нуля» — конструктор без шаблона (служебка, письмо).
 * Вид документа обязателен: на нём держатся нумерация, видимость и подшивка.
 */
export const createFreeOrgDocumentSchema = z.object({
  docTypeId: z.string().uuid(),
  title: safeText(DOC_LIMITS.maxTitleLength),
  /** Сторона документа. Пусто — сам автор */
  subjectUserId: z.string().uuid().optional(),
  counterpartyId: z.string().uuid().optional(),
  counterpartyContactId: z.string().uuid().optional(),
  builderDoc: builderDocSchema.optional(),
  /** Свои поля документа (даты/числа удобными контролами) — можно завести сразу */
  formFields: z.array(docFormFieldSchema).max(DOC_LIMITS.maxFormFields).optional(),
});

/**
 * Загрузка ГОТОВОГО файла как документа (третий путь создания): договор уже
 * согласован в Word/PDF вне платформы — сюда он приходит на подпись и в реестр.
 * Файл загружен обычным путём движка файлов (профиль `document`), сервис сузит
 * MIME до PDF и DOCX и проверит владение файлом.
 */
export const createUploadedOrgDocumentSchema = z.object({
  docTypeId: z.string().uuid(),
  fileId: z.string().uuid(),
  title: safeText(DOC_LIMITS.maxTitleLength).optional(),
  subjectUserId: z.string().uuid().optional(),
  counterpartyId: z.string().uuid().optional(),
  counterpartyContactId: z.string().uuid().optional(),
});

/**
 * Отправить документ контрагенту (внешний этап). Внутренних подписантов минимум
 * один — правило ПРОДУКТА (двусторонний документ без подписи своей стороны не
 * имеет смысла); движок подписи внутренних не требует, и это его право.
 */
export const sendExternalOrgDocumentSchema = z.object({
  counterpartyContactId: z.string().uuid(),
  internalSignerUserIds: z.array(z.string().uuid()).min(1).max(10),
  /** Срок подписания; пусто — DOC_EXTERNAL_DEFAULT_TTL_DAYS от отправки */
  expiresAt: z.string().datetime().optional(),
  /** Отправить SMS со ссылкой на номер контакта (при живом SMS-драйвере) */
  sendSms: z.boolean().optional(),
});

export const listOrgDocumentsSchema = z.object({
  docTypeId: z.string().uuid().optional(),
  status: z.string().max(30).optional(),
  /** Категория вида: вкладка «С контрагентами» = category=external */
  category: categoryEnum.optional(),
  /** Документы конкретного контрагента (фильтр с его карточки) */
  counterpartyId: z.string().uuid().optional(),
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
export type CreateFreeOrgDocumentInput = z.infer<typeof createFreeOrgDocumentSchema>;
export type CreateUploadedOrgDocumentInput = z.infer<typeof createUploadedOrgDocumentSchema>;
export type SendExternalOrgDocumentInput = z.infer<typeof sendExternalOrgDocumentSchema>;
export type ListOrgDocumentsInput = z.infer<typeof listOrgDocumentsSchema>;
