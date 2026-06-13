import { z } from 'zod';

const noHtml = (s: string) => !/[<>]/.test(s);

/** Семантический id ноды/поля анкеты: латиница, цифры, _ и -, начинается с буквы. */
export const processIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'id: латиница/цифры/_/-, начинается с буквы');

const processLabelSchema = z
  .string()
  .max(120, 'Подпись слишком длинная')
  .refine(noHtml, 'Недопустимые символы');

export const processFormFieldSchema = z.object({
  key: processIdSchema,
  label: z.string().min(1).max(80).refine(noHtml, 'Недопустимые символы'),
  type: z.enum(['text', 'number', 'boolean', 'date', 'select']),
  required: z.boolean().optional(),
  options: z
    .array(z.string().min(1).max(80).refine(noHtml, 'Недопустимые символы'))
    .max(30)
    .optional(),
});

export const processNodeSchema = z.object({
  id: processIdSchema,
  type: z.string().min(1).max(60),
  label: processLabelSchema.optional(),
  note: z.string().max(500).refine(noHtml, 'Недопустимые символы').optional(),
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const processEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  from: processIdSchema,
  fromPort: z.string().max(24).optional(),
  to: processIdSchema,
  toPort: z.string().max(24).optional(),
});

/** Форма канвас-документа. Графовая целостность проверяется компилятором (issues с привязкой к нодам). */
export const processDocumentSchema = z.object({
  nodes: z.array(processNodeSchema).min(1, 'Документ пуст').max(150, 'Слишком много нод'),
  edges: z.array(processEdgeSchema).max(300, 'Слишком много связей'),
  form: z.array(processFormFieldSchema).max(30, 'Слишком много полей анкеты').default([]),
});

export const createProcessDefinitionSchema = z.object({
  name: z.string().min(1, 'Название обязательно').max(100).refine(noHtml, 'Недопустимые символы'),
  description: z.string().max(500).refine(noHtml, 'Недопустимые символы').nullable().optional(),
});

export const updateProcessDefinitionSchema = z
  .object({
    name: z.string().min(1).max(100).refine(noHtml, 'Недопустимые символы').optional(),
    description: z.string().max(500).refine(noHtml, 'Недопустимые символы').nullable().optional(),
    visibility: z.enum(['team', 'admins']).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

export const saveProcessDocumentSchema = z.object({
  document: processDocumentSchema,
});

/** Запуск: значения анкеты; типы/обязательность проверяются сервером по форме версии. */
export const startProcessSchema = z.object({
  input: z.record(z.unknown()).default({}),
});

/** Ф2: решение по одобрению. */
export const decideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

/** Ф2.5: переназначить исполнителя шага. */
export const reassignStepSchema = z.object({
  userId: z.string().uuid(),
});

// ---------- Ф3: триггеры ----------

export const createProcessTriggerSchema = z
  .object({
    type: z.enum(['event', 'schedule', 'webhook']),
    runAsUserId: z.string().uuid(),
    // event:
    eventType: z.string().max(60).optional(),
    // schedule:
    everyValue: z.coerce.number().int().min(1).max(100000).optional(),
    everyUnit: z.enum(['hours', 'days']).optional(),
  })
  .refine((d) => d.type !== 'event' || !!d.eventType, { message: 'Выберите событие', path: ['eventType'] })
  .refine((d) => d.type !== 'schedule' || (!!d.everyValue && !!d.everyUnit), { message: 'Укажите интервал', path: ['everyValue'] });

export const updateProcessTriggerSchema = z.object({
  enabled: z.boolean(),
});

// ---------- Ф3: креды ----------

const noHtmlCred = (s: string) => !/[<>]/.test(s);
export const createProcessCredentialSchema = z
  .object({
    name: z.string().min(1).max(80).refine(noHtmlCred, 'Недопустимые символы'),
    type: z.enum(['header', 'basic', 'bearer']),
    // секреты (наружу не отдаются):
    token: z.string().max(2000).optional(),
    username: z.string().max(200).optional(),
    password: z.string().max(500).optional(),
    headerName: z.string().max(100).optional(),
    headerValue: z.string().max(2000).optional(),
  })
  .refine((d) => d.type !== 'bearer' || !!d.token, { message: 'Укажите токен', path: ['token'] })
  .refine((d) => d.type !== 'basic' || (!!d.username && !!d.password), { message: 'Логин и пароль', path: ['username'] })
  .refine((d) => d.type !== 'header' || (!!d.headerName && !!d.headerValue), { message: 'Имя и значение заголовка', path: ['headerName'] });
