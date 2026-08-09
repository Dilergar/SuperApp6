import { z } from 'zod';
import { DOC_BUILDER_VERSION, type BuilderDoc } from '../types/doc-builder';

// ============================================================
// Блочный конструктор документов — Zod-схема формата BuilderDoc.
//
// Лимиты консервативные: печатный документ, а не вики. Всё, что не проходит,
// отклоняется на входе — в БД лежит только валидный документ.
// ============================================================

export const DOC_BUILDER_LIMITS = {
  maxBlocks: 500,
  maxInlinePerBlock: 200,
  maxTextLength: 5000,
  maxTableRows: 100,
  maxTableCols: 12,
  maxListDepth: 3,
} as const;

const textStylesSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
  })
  .strict();

const inlineTextSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(DOC_BUILDER_LIMITS.maxTextLength),
  styles: textStylesSchema.optional(),
});

/** Тот же алфавит, что у docx-тегов: без скобок, точек внутри частей и < > */
const chipPathSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .refine((v) => /^[^{}.|<>\n]{1,60}\.[^{}.|<>\n]{1,60}$/.test(v), {
    message: 'Путь чипа — «Группа.Поле» без { } . | < > внутри частей',
  });

const inlineChipSchema = z.object({
  type: z.literal('chip'),
  props: z.object({
    path: chipPathSchema,
    format: z.string().trim().max(60).optional(),
    label: z.string().trim().max(120).optional(),
  }),
});

const inlineSchema = z.discriminatedUnion('type', [inlineTextSchema, inlineChipSchema]);
const inlineArraySchema = z.array(inlineSchema).max(DOC_BUILDER_LIMITS.maxInlinePerBlock);

const alignSchema = z.enum(['left', 'center', 'right', 'justify']);
const blockIdSchema = z.string().trim().min(1).max(64);

const paragraphSchema = z.object({
  id: blockIdSchema,
  type: z.literal('paragraph'),
  props: z.object({ align: alignSchema.optional() }).optional(),
  content: inlineArraySchema,
});

const headingSchema = z.object({
  id: blockIdSchema,
  type: z.literal('heading'),
  props: z.object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    align: alignSchema.optional(),
  }),
  content: inlineArraySchema,
});

/** Вложенность списков ограничена рекурсией руками — у Zod lazy нет лимита глубины */
function listItemSchema(depth: number): z.ZodType {
  const base = {
    id: blockIdSchema,
    type: z.enum(['bulletListItem', 'numberedListItem']),
    content: inlineArraySchema,
  };
  if (depth >= DOC_BUILDER_LIMITS.maxListDepth) return z.object(base).strict();
  return z
    .object({
      ...base,
      children: z.array(z.lazy(() => listItemSchema(depth + 1))).max(50).optional(),
    })
    .strict();
}

const tableSchema = z.object({
  id: blockIdSchema,
  type: z.literal('table'),
  props: z
    .object({
      columnWidths: z.array(z.number().positive().max(100)).max(DOC_BUILDER_LIMITS.maxTableCols).optional(),
      headerRow: z.boolean().optional(),
    })
    .optional(),
  rows: z
    .array(z.object({ cells: z.array(inlineArraySchema).min(1).max(DOC_BUILDER_LIMITS.maxTableCols) }))
    .min(1)
    .max(DOC_BUILDER_LIMITS.maxTableRows),
});

const requisitesSchema = z.object({
  id: blockIdSchema,
  type: z.literal('requisites'),
  props: z.object({ showLogo: z.boolean().optional() }).optional(),
});

const docMetaSchema = z.object({
  id: blockIdSchema,
  type: z.literal('docMeta'),
  props: z.object({ align: alignSchema.optional() }).optional(),
});

const signatureSchema = z.object({
  id: blockIdSchema,
  type: z.literal('signature'),
  props: z.object({
    role: z.string().trim().min(1).max(120).refine((v) => !/[<>]/.test(v), { message: 'Символы < и > запрещены' }),
    nameSource: z.enum(['subject', 'director', 'custom', 'none']),
    customName: z.string().trim().max(120).refine((v) => !/[<>]/.test(v), { message: 'Символы < и > запрещены' }).optional(),
    stamp: z.boolean().optional(),
  }),
});

const pageBreakSchema = z.object({
  id: blockIdSchema,
  type: z.literal('pageBreak'),
});

const blockSchema = z.discriminatedUnion('type', [
  paragraphSchema,
  headingSchema,
  listItemSchema(1) as z.ZodDiscriminatedUnionOption<'type'>,
  tableSchema,
  requisitesSchema,
  docMetaSchema,
  signatureSchema,
  pageBreakSchema,
]);

/**
 * Форма провода — `BuilderDoc` из types/doc-builder (осознанное исключение из
 * правила «тип входа = z.infer»: рекурсивные списки + discriminatedUnion не
 * инферятся чисто, а формат и так один на вход и выход — как CardVisibility).
 */
export const builderDocSchema: z.ZodType<BuilderDoc> = z.object({
  version: z.literal(DOC_BUILDER_VERSION),
  page: z
    .object({ footer: z.enum(['none', 'pageNumbers']).optional() })
    .optional(),
  blocks: z.array(blockSchema).max(DOC_BUILDER_LIMITS.maxBlocks),
}) as unknown as z.ZodType<BuilderDoc>;
