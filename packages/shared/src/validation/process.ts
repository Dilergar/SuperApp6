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
  /**
   * Профиль редактора: режет палитру нод и включает правила предметной области.
   * Приходит от сервиса-заказчика («Документы» заводят кадровый маршрут), а не от
   * человека — в общем списке процессов выбора профиля нет.
   */
  surface: z.string().max(40).refine(noHtml, 'Недопустимые символы').optional(),
  /**
   * Готовая заготовка канваса. Пустой холст на 32 ноды кадровика отпугивает, поэтому
   * маршрут документа заводится уже собранным — остаётся указать, кто подписывает.
   */
  document: processDocumentSchema.optional(),
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
  // 'returned' — «на доработку»: не «нет», а «поправь и пришли снова». Появилось
  // вместе с движком согласований; у ноды это НЕОБЯЗАТЕЛЬНЫЙ выход, поэтому в
  // маршрутах без такой ветки токен уходит по «Отклонено».
  decision: z.enum(['approved', 'rejected', 'returned']),
  // Причина. Обязательность проверяет ДВИЖОК согласований (отказ и возврат без
  // объяснения делают маршрут бесполезным), а не эта схема: правило одно на все
  // поверхности — и на карточку запуска, и на общую стопку, и на чат.
  comment: z.string().trim().max(2000).optional(),
});

/**
 * Публикация. `acceptWarnings` — ключи правил предметной области, которые человек
 * ЯВНО принял к сведению («Понимаю, публикую»). Поимённо, а не одним флагом: согласие
 * с одним правилом не должно молча накрывать остальные, включая те, что появятся
 * в следующем релизе закона.
 */
export const publishProcessSchema = z
  .object({
    acceptWarnings: z.array(z.string().max(64)).max(50).optional().default([]),
  })
  .strict();

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
