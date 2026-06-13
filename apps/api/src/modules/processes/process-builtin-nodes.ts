import { z } from 'zod';
import { PROCESS_CONDITION_OPS, PROCESS_EVENT_TYPES, PROCESS_SCHEDULE_UNITS } from '@superapp/shared';
import type { ProcessNodeProvider } from './process-node.types';

const noHtml = (s: string) => !/[<>]/.test(s);
const textField = (max: number, min = 0) =>
  z.string().min(min, 'Поле обязательно').max(max).refine(noHtml, 'Недопустимые символы');

/**
 * Runtime-проверка членства: публикация валидирует состав, но человек мог быть уволен
 * ПОСЛЕ неё — устаревшая опубликованная версия не должна раздавать задачи бывшим.
 */
async function assertActiveMember(
  ctx: import('./process-node.types').NodeRunContext,
  userId: string,
  who: string,
): Promise<void> {
  const count = await ctx.deps.db.userRole.count({
    where: {
      userId,
      context: 'workspace',
      tenantId: ctx.workspaceId,
      isActive: true,
      role: { not: 'contractor' },
    },
  });
  if (count === 0) throw new Error(`${who} больше не работает в организации`);
}

// ============================================================
// Встроенные ноды: Триггеры запуска · Задача · Если · Уведомить · Конец.
// Чистые объекты без DI — сервисы приходят через ctx.deps (модель n8n supplyData:
// нода описывает себя декларативно, движок снабжает её живыми клиентами).
//
// ТРИГГЕРЫ (модель n8n): фиксированного «Старт» нет — процесс начинается с триггер-ноды
// (без входа, можно несколько, удаляется). Триггер-ноды auto и сразу завершаются —
// токен уходит дальше по потоку. Автоматические триггеры (расписание/вебхук/событие)
// синхронизируются в таблицу ProcessTrigger при ПУБЛИКАЦИИ (см. ProcessesService).
// ============================================================

/** runAs — действующий сотрудник, от чьего лица идёт авто-запущенный процесс (создаёт задачи/уведомления). */
const runAsField = {
  key: 'runAsUserId',
  label: 'От имени',
  kind: 'member' as const,
  required: true,
  help: 'От чьего лица идёт процесс при авто-запуске (создаёт задачи, шлёт уведомления).',
};

/** Триггер «Запуск вручную»: человек жмёт «Запустить» и заполняет анкету. Точка входа по умолчанию. */
export const startNode: ProcessNodeProvider = {
  descriptor: {
    type: 'start', // тип-ключ сохранён (back-compat с сохранёнными документами)
    title: 'Запуск вручную',
    description:
      'Запуск кнопкой «Запустить»: инициатор заполняет анкету и стартует процесс. Точка входа — её можно удалить, если запуск только автоматический.',
    category: 'trigger',
    icon: '🚀',
    tier: 'standard',
    trigger: true,
    outputs: [{ key: 'main', label: '' }],
    fields: [],
    configSchema: z.object({}).passthrough(),
    auto: true,
  },
  async run() {
    return { kind: 'complete' };
  },
};

/** Триггер «По расписанию»: процесс запускается сам каждые N часов/дней (синхра в ProcessTrigger при публикации). */
export const scheduleTriggerNode: ProcessNodeProvider = {
  descriptor: {
    type: 'trigger.schedule',
    title: 'По расписанию',
    description: 'Запускает процесс автоматически каждые N часов/дней. Анкета не заполняется (берёт значения по умолчанию).',
    category: 'trigger',
    icon: '⏰',
    tier: 'standard',
    trigger: true,
    outputs: [{ key: 'main', label: '' }],
    fields: [
      { key: 'everyValue', label: 'Каждые', kind: 'number', required: true, placeholder: '1' },
      {
        key: 'everyUnit',
        label: 'Единица',
        kind: 'select',
        required: true,
        options: PROCESS_SCHEDULE_UNITS.map((u) => ({ value: u.value, label: u.label })),
      },
      runAsField,
    ],
    configSchema: z.object({
      everyValue: z.coerce.number().int().min(1).max(100000),
      everyUnit: z.enum(['hours', 'days']),
      runAsUserId: z.string().uuid('Выберите, от чьего имени идёт процесс'),
    }),
    auto: true,
  },
  async run() {
    return { kind: 'complete' };
  },
};

/** Триггер «Веб-хук»: внешняя система (Kaspi/1С/любой сервис) дёргает публичный URL → процесс стартует. */
export const webhookTriggerNode: ProcessNodeProvider = {
  descriptor: {
    type: 'trigger.webhook',
    title: 'Веб-хук',
    description: 'Внешняя система (Kaspi, 1С, сайт…) вызывает публичный URL — процесс запускается. URL появится в этой панели после публикации; тело запроса попадает в анкету.',
    category: 'trigger',
    icon: '🌐',
    tier: 'standard',
    trigger: true,
    outputs: [{ key: 'main', label: '' }],
    fields: [runAsField],
    configSchema: z.object({
      runAsUserId: z.string().uuid('Выберите, от чьего имени идёт процесс'),
    }),
    auto: true,
  },
  async run() {
    return { kind: 'complete' };
  },
};

/** Триггер «Событие в SuperApp»: процесс стартует на событие платформы (нанят сотрудник, завершена задача…). */
export const eventTriggerNode: ProcessNodeProvider = {
  descriptor: {
    type: 'trigger.event',
    title: 'Событие в SuperApp',
    description: 'Запускает процесс на событие платформы: принят сотрудник, назначена должность, завершена/создана задача и т.п.',
    category: 'trigger',
    icon: '📡',
    tier: 'standard',
    trigger: true,
    outputs: [{ key: 'main', label: '' }],
    fields: [
      {
        key: 'eventType',
        label: 'Событие',
        kind: 'select',
        required: true,
        options: PROCESS_EVENT_TYPES.map((e) => ({ value: e.value, label: e.label })),
      },
      runAsField,
    ],
    configSchema: z.object({
      eventType: z.string().refine((v) => PROCESS_EVENT_TYPES.some((e) => e.value === v), 'Выберите событие'),
      runAsUserId: z.string().uuid('Выберите, от чьего имени идёт процесс'),
    }),
    auto: true,
  },
  async run() {
    return { kind: 'complete' };
  },
};

/**
 * Триггер «Telegram: входящее» — боту написали в Telegram → процесс стартует.
 * Модель n8n Telegram Trigger: сообщение приходит вебхуком, его текст/чат попадают в
 * анкету, ответ отправляется отдельной нодой «Telegram» (Chat ID = {{form.chatId}}).
 * Вебхук бота регистрируется автоматически при публикации (нужен публичный API-адрес).
 */
export const telegramTriggerNode: ProcessNodeProvider = {
  descriptor: {
    type: 'trigger.telegram',
    title: 'Telegram: входящее',
    description:
      'Запускает процесс, когда боту пишут в Telegram. Доступно нодам: текст → {{form.text}}, чат → {{form.chatId}}, имя → {{form.fromName}}. Ответ — нодой «Telegram» с Chat ID = {{form.chatId}}.',
    category: 'trigger',
    icon: '✈️',
    tier: 'standard',
    trigger: true,
    outputs: [{ key: 'main', label: '' }],
    fields: [
      {
        key: 'credentialId',
        label: 'Токен бота (кред)',
        kind: 'credential',
        required: true,
        help: 'Bearer-кред с токеном от @BotFather. После публикации вебхук бота настроится сам (нужен публичный API-адрес; на localhost — настроить вручную).',
      },
      runAsField,
    ],
    configSchema: z.object({
      credentialId: z.string().uuid('Выберите кред с токеном бота'),
      runAsUserId: z.string().uuid('Выберите, от чьего имени идёт процесс'),
    }),
    auto: true,
  },
  async run() {
    return { kind: 'complete' };
  },
};

/** Члены отдела (с учётом подотделов — closure спроецирован StaffModule в core/access). */
async function departmentMemberIds(
  ctx: import('./process-node.types').NodeRunContext,
  departmentId: string,
): Promise<string[]> {
  const rows = await ctx.deps.db.relationTuple.findMany({
    where: { resourceType: 'department', resourceId: departmentId, relation: 'member', subjectType: 'user' },
    select: { subjectId: true },
  });
  return [...new Set(rows.map((r) => r.subjectId))];
}

function deadlineFrom(hours?: number): Date | undefined {
  return hours ? new Date(Date.now() + hours * 3_600_000) : undefined;
}

/**
 * Задача: режим «Сотрудник»/«Инициатор» → сразу создаёт задачу Задачника и ждёт приёмки;
 * режим «Отдел» → встаёт в ОЧЕРЕДЬ отдела (без задачи) — любой член отдела забирает её
 * (claim), и лишь тогда создаётся реальная задача (модель Camunda candidate-group).
 */
export const humanTaskNode: ProcessNodeProvider = {
  descriptor: {
    type: 'human.task',
    title: 'Задача человеку',
    description:
      'Создаёт задачу в Задачнике (чат, напоминания) и ждёт приёмки. Режим «Отдел» — задача встаёт в очередь, её забирает любой сотрудник отдела. Подстановки {{form.поле}}.',
    category: 'people',
    icon: '📋',
    tier: 'standard',
    outputs: [{ key: 'main', label: '' }],
    fields: [
      { key: 'title', label: 'Название задачи', kind: 'text', required: true, placeholder: 'Найти стиральную машину до {{form.budget}} ₸' },
      { key: 'description', label: 'Описание', kind: 'textarea', placeholder: 'Что нужно сделать (видно исполнителю)' },
      {
        key: 'assigneeMode',
        label: 'Исполнитель',
        kind: 'select',
        required: true,
        options: [
          { value: 'member', label: 'Сотрудник' },
          { value: 'department', label: 'Отдел (очередь)' },
          { value: 'initiator', label: 'Инициатор процесса' },
        ],
      },
      { key: 'assigneeUserId', label: 'Кто', kind: 'member', showIf: { field: 'assigneeMode', in: ['member'] } },
      { key: 'departmentId', label: 'Отдел', kind: 'department', showIf: { field: 'assigneeMode', in: ['department'] } },
      { key: 'dueInHours', label: 'Срок (часов с момента шага)', kind: 'number', placeholder: '24' },
    ],
    configSchema: z
      .object({
        title: textField(200, 1),
        description: textField(2000).optional(),
        assigneeMode: z.enum(['member', 'department', 'initiator']),
        assigneeUserId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(),
        dueInHours: z.coerce.number().int().min(1).max(24 * 365).optional(),
      })
      .refine((c) => c.assigneeMode !== 'member' || !!c.assigneeUserId, {
        message: 'Выберите сотрудника-исполнителя',
        path: ['assigneeUserId'],
      })
      .refine((c) => c.assigneeMode !== 'department' || !!c.departmentId, {
        message: 'Выберите отдел',
        path: ['departmentId'],
      }),
    auto: false, // токен «спит» в БД, пока задачу не примут/не заберут — Wait-механика n8n
  },
  validateConfig(config, doc) {
    void doc;
    return [];
  },
  async run(ctx) {
    const cfg = ctx.config as {
      title: string;
      description?: string;
      assigneeMode: 'member' | 'department' | 'initiator';
      assigneeUserId?: string;
      departmentId?: string;
      dueInHours?: number;
    };
    const title = ctx.render(cfg.title);
    const description = cfg.description ? ctx.render(cfg.description) : undefined;
    const deadlineAt = deadlineFrom(cfg.dueInHours);

    if (cfg.assigneeMode === 'department') {
      // Очередь отдела: ни задачи, ни исполнителя — уведомляем отдел, ждём claim.
      const dep = await ctx.deps.db.staffDepartment.findUnique({
        where: { id: cfg.departmentId! },
        select: { name: true, workspaceId: true },
      });
      if (!dep || dep.workspaceId !== ctx.workspaceId) throw new Error('Отдел не найден');
      const memberIds = await departmentMemberIds(ctx, cfg.departmentId!);
      for (const uid of memberIds) {
        await ctx.deps.notifications
          .notify(uid, 'process.task.queued', { title, departmentName: dep.name, processName: ctx.definitionName }, {
            actionUrl: `/workspaces/${ctx.workspaceId}/processes/inbox`,
          })
          .catch(() => undefined);
      }
      return {
        kind: 'wait',
        patch: { departmentId: cfg.departmentId, deadlineAt },
        // спецификация будущей задачи (claim прочитает её отсюда)
        output: { kind: 'queue', title, description: description ?? null, dueInHours: cfg.dueInHours ?? null, departmentName: dep.name },
      };
    }

    const assigneeId = cfg.assigneeMode === 'initiator' ? ctx.startedById : cfg.assigneeUserId!;
    await assertActiveMember(ctx, assigneeId, 'Исполнитель шага');
    // Создаём от имени инициатора (он — Постановщик и принимает работу).
    const task = await ctx.deps.tasks.createTask(
      ctx.startedById,
      {
        title,
        description,
        executorId: assigneeId,
        dueDate: deadlineAt?.toISOString(),
        workspaceId: ctx.workspaceId,
      } as Parameters<typeof ctx.deps.tasks.createTask>[1],
      { skipEnvironmentChecks: true },
    );
    return { kind: 'wait', patch: { taskId: task.id, assigneeId, deadlineAt }, output: { taskId: task.id } };
  },
};

/** Одобрение: согласующий выносит решение «Одобрить»/«Отклонить» → ветки approved/rejected. */
export const approvalNode: ProcessNodeProvider = {
  descriptor: {
    type: 'human.approval',
    title: 'Одобрение',
    description:
      'Ждёт решения согласующего: «Одобрить» или «Отклонить» — токен идёт по соответствующей ветке (отклонение можно вернуть назад связью). Подстановки {{form.поле}}.',
    category: 'people',
    icon: '✅',
    tier: 'standard',
    outputs: [
      { key: 'approved', label: 'Одобрено' },
      { key: 'rejected', label: 'Отклонено' },
    ],
    fields: [
      { key: 'title', label: 'Что одобрить', kind: 'text', required: true, placeholder: 'Покупка стиральной машины за {{form.budget}} ₸' },
      {
        key: 'assigneeMode',
        label: 'Согласующий',
        kind: 'select',
        required: true,
        options: [
          { value: 'member', label: 'Сотрудник' },
          { value: 'initiator', label: 'Инициатор процесса' },
        ],
      },
      { key: 'assigneeUserId', label: 'Кто', kind: 'member', showIf: { field: 'assigneeMode', in: ['member'] } },
      { key: 'dueInHours', label: 'Срок решения (часов)', kind: 'number', placeholder: '24' },
    ],
    configSchema: z
      .object({
        title: textField(200, 1),
        assigneeMode: z.enum(['member', 'initiator']),
        assigneeUserId: z.string().uuid().optional(),
        dueInHours: z.coerce.number().int().min(1).max(24 * 365).optional(),
      })
      .refine((c) => c.assigneeMode !== 'member' || !!c.assigneeUserId, {
        message: 'Выберите согласующего',
        path: ['assigneeUserId'],
      }),
    auto: false,
  },
  async run(ctx) {
    const cfg = ctx.config as { title: string; assigneeMode: 'member' | 'initiator'; assigneeUserId?: string; dueInHours?: number };
    const approverId = cfg.assigneeMode === 'initiator' ? ctx.startedById : cfg.assigneeUserId!;
    await assertActiveMember(ctx, approverId, 'Согласующий');
    const title = ctx.render(cfg.title);
    await ctx.deps.notifications
      .notify(approverId, 'process.approval.requested', { title, processName: ctx.definitionName }, {
        actionUrl: `/workspaces/${ctx.workspaceId}/processes/instances/${ctx.instanceId}`,
      })
      .catch(() => undefined);
    return { kind: 'wait', patch: { assigneeId: approverId, deadlineAt: deadlineFrom(cfg.dueInHours) }, output: { kind: 'approval', title } };
  },
};

/** Пауза: токен ждёт заданное время, затем идёт дальше (таймер добивается кроном). */
export const delayNode: ProcessNodeProvider = {
  descriptor: {
    type: 'delay',
    title: 'Пауза',
    description: 'Останавливает процесс на заданное время, затем продолжает.',
    category: 'flow',
    icon: '⏳',
    tier: 'standard',
    outputs: [{ key: 'main', label: '' }],
    fields: [
      { key: 'amount', label: 'Сколько ждать', kind: 'number', required: true, placeholder: '1' },
      {
        key: 'unit',
        label: 'Единица',
        kind: 'select',
        required: true,
        options: [
          { value: 'minutes', label: 'минут' },
          { value: 'hours', label: 'часов' },
          { value: 'days', label: 'дней' },
        ],
      },
    ],
    configSchema: z.object({
      amount: z.coerce.number().int().min(1).max(100000),
      unit: z.enum(['minutes', 'hours', 'days']),
    }),
    auto: false, // ждёт времени; добивает ProcessesCron
  },
  async run(ctx) {
    const cfg = ctx.config as { amount: number; unit: 'minutes' | 'hours' | 'days' };
    const ms = cfg.amount * DELAY_UNIT_MS[cfg.unit];
    const until = new Date(Date.now() + ms);
    return { kind: 'wait', patch: { deadlineAt: until }, output: { kind: 'delay', until: until.toISOString() } };
  },
};

const DELAY_UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** Если: сравнение поля анкеты с константой → ветки «Да»/«Нет». Без языка выражений. */
export const conditionNode: ProcessNodeProvider = {
  descriptor: {
    type: 'condition',
    title: 'Если',
    description: 'Сравнивает поле анкеты с значением и ведёт токен по ветке «Да» или «Нет».',
    category: 'flow',
    icon: '🔀',
    tier: 'standard',
    outputs: [
      { key: 'true', label: 'Да' },
      { key: 'false', label: 'Нет' },
    ],
    fields: [
      { key: 'field', label: 'Поле анкеты', kind: 'formField', required: true },
      {
        key: 'op',
        label: 'Условие',
        kind: 'select',
        required: true,
        options: PROCESS_CONDITION_OPS.map((o) => ({ value: o.value, label: o.label })),
      },
      {
        key: 'value',
        label: 'Значение',
        kind: 'text',
        showIf: { field: 'op', in: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'] },
      },
    ],
    configSchema: z.object({
      field: z.string().min(1, 'Выберите поле анкеты').max(48),
      op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty']),
      value: textField(200).optional(),
    }),
    auto: true,
  },
  validateConfig(config, doc) {
    const field = config.field as string | undefined;
    if (field && !doc.form.some((f) => f.key === field)) {
      return [{ field: 'field', message: `Поле анкеты «${field}» не существует` }];
    }
    return [];
  },
  async run(ctx) {
    const cfg = ctx.config as { field: string; op: string; value?: string };
    const raw = ctx.variables[cfg.field];
    const result = evalCondition(raw, cfg.op, cfg.value);
    return {
      kind: 'complete',
      outputKey: result ? 'true' : 'false',
      output: { field: cfg.field, value: raw ?? null, result },
    };
  },
};

function evalCondition(raw: unknown, op: string, expected?: string): boolean {
  const isEmpty = raw === null || raw === undefined || raw === '';
  if (op === 'empty') return isEmpty;
  if (op === 'not_empty') return !isEmpty;

  const exp = expected ?? '';
  const numRaw = typeof raw === 'number' ? raw : Number(raw);
  const numExp = Number(exp);
  const bothNumeric = !isEmpty && !Number.isNaN(numRaw) && exp.trim() !== '' && !Number.isNaN(numExp);

  switch (op) {
    case 'eq':
      if (typeof raw === 'boolean') return raw === (exp === 'true' || exp === 'да');
      return bothNumeric ? numRaw === numExp : String(raw ?? '') === exp;
    case 'ne':
      if (typeof raw === 'boolean') return raw !== (exp === 'true' || exp === 'да');
      return bothNumeric ? numRaw !== numExp : String(raw ?? '') !== exp;
    case 'gt':
      return bothNumeric && numRaw > numExp;
    case 'gte':
      return bothNumeric && numRaw >= numExp;
    case 'lt':
      return bothNumeric && numRaw < numExp;
    case 'lte':
      return bothNumeric && numRaw <= numExp;
    case 'contains':
      return String(raw ?? '').toLowerCase().includes(exp.toLowerCase());
    default:
      return false;
  }
}

/** Уведомить: платформенное уведомление инициатору или сотруднику. */
export const notifyNode: ProcessNodeProvider = {
  descriptor: {
    type: 'notify',
    title: 'Уведомить',
    description: 'Отправляет уведомление инициатору или выбранному сотруднику. Поддерживает подстановки {{form.поле}}.',
    category: 'service',
    icon: '🔔',
    tier: 'standard',
    // main — поток; astool — подключение к AI-Агенту как инструмент (один узел = действие И инструмент, модель n8n).
    outputs: [
      { key: 'main', label: '' },
      { key: 'astool', label: 'как инструмент', type: 'ai_tool' },
    ],
    fields: [
      {
        key: 'to',
        label: 'Кому',
        kind: 'select',
        required: true,
        options: [
          { value: 'initiator', label: 'Инициатору процесса' },
          { value: 'member', label: 'Сотруднику' },
        ],
      },
      { key: 'userId', label: 'Кто', kind: 'member', showIf: { field: 'to', in: ['member'] } },
      { key: 'title', label: 'Заголовок', kind: 'text', help: 'Для обычной ноды — обязательно. Как инструмент агента: текст придумывает агент (шлёт инициатору).' },
      { key: 'message', label: 'Текст', kind: 'textarea' },
    ],
    configSchema: z
      .object({
        to: z.enum(['initiator', 'member']),
        userId: z.string().uuid().optional(),
        title: textField(150).optional(),
        message: textField(600).optional(),
      })
      .refine((c) => c.to !== 'member' || !!c.userId, {
        message: 'Выберите получателя',
        path: ['userId'],
      }),
    auto: true,
    tool: {
      name: 'notify_initiator',
      description: 'Отправить короткое уведомление инициатору процесса.',
      schema: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['title'] },
      async execute(ctx, input) {
        await ctx.deps.notifications
          .notify(ctx.startedById, 'process.step.notify', { title: String(input.title ?? 'AI'), message: String(input.message ?? '') }, {
            actionUrl: `/workspaces/${ctx.workspaceId}/processes/instances/${ctx.instanceId}`,
          })
          .catch(() => undefined);
        return 'Уведомление отправлено';
      },
    },
  },
  async run(ctx) {
    const cfg = ctx.config as { to: 'initiator' | 'member'; userId?: string; title?: string; message?: string };
    if (!cfg.title) throw new Error('Заполните заголовок уведомления');
    const recipientId = cfg.to === 'initiator' ? ctx.startedById : cfg.userId!;
    if (cfg.to === 'member') await assertActiveMember(ctx, recipientId, 'Получатель уведомления');
    await ctx.deps.notifications.notify(
      recipientId,
      'process.step.notify',
      { title: ctx.render(cfg.title), message: cfg.message ? ctx.render(cfg.message) : '' },
      { actionUrl: `/workspaces/${ctx.workspaceId}/processes/instances/${ctx.instanceId}` },
    );
    return { kind: 'complete', output: { recipientId } };
  },
};

/** Развилка: запускает несколько веток параллельно (fork). Каждое исходящее ребро = свой токен. */
export const splitNode: ProcessNodeProvider = {
  descriptor: {
    type: 'parallel.split',
    title: 'Развилка',
    description: 'Запускает несколько веток одновременно — все идут параллельно. Соедините выход с 2+ нодами.',
    category: 'flow',
    icon: '🔱',
    tier: 'standard',
    outputs: [{ key: 'main', label: '' }],
    fields: [],
    configSchema: z.object({}).passthrough(),
    auto: true,
    multiOut: true, // выход «main» ведёт к нескольким нодам (компилятор разрешает)
  },
  async run() {
    return { kind: 'complete' };
  },
};

/** Слияние: ждёт завершения ВСЕХ входящих параллельных веток, затем продолжает один токен (join). */
export const joinNode: ProcessNodeProvider = {
  descriptor: {
    type: 'parallel.join',
    title: 'Слияние',
    description: 'Ждёт, пока завершатся все параллельные ветки, затем продолжает. Соедините 2+ ветки в его вход.',
    category: 'flow',
    icon: '⥇',
    tier: 'standard',
    outputs: [{ key: 'main', label: '' }],
    fields: [],
    configSchema: z.object({}).passthrough(),
    auto: false, // ждёт прибытия всех токенов; будится депозитом ветки (activated=false)
    join: true,
  },
  async run(ctx) {
    const j = ctx.join ?? { arrivals: 0, expected: 1 };
    if (j.arrivals >= j.expected) return { kind: 'complete', output: { arrivals: j.arrivals } };
    // ещё не все ветки пришли — спим (следующий депозит разбудит)
    return { kind: 'wait', output: { arrivals: j.arrivals, expected: j.expected } };
  },
};

/** Конец: терминальная нода — инстанс завершается. */
export const endNode: ProcessNodeProvider = {
  descriptor: {
    type: 'end',
    title: 'Конец',
    description: 'Завершает процесс.',
    category: 'flow',
    icon: '🏁',
    tier: 'standard',
    outputs: [],
    terminal: true,
    fields: [],
    configSchema: z.object({}).passthrough(),
    auto: true,
  },
  async run() {
    return { kind: 'complete' };
  },
};

export const BUILTIN_PROCESS_NODES: ProcessNodeProvider[] = [
  startNode,
  scheduleTriggerNode,
  webhookTriggerNode,
  eventTriggerNode,
  telegramTriggerNode,
  humanTaskNode,
  approvalNode,
  conditionNode,
  splitNode,
  joinNode,
  delayNode,
  notifyNode,
  endNode,
];
