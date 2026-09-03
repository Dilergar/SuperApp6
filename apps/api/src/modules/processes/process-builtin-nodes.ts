import { z } from 'zod';
import { AudiencesService } from '../../core/audiences/audiences.service';
import {
  PROCESS_CONDITION_OPS,
  PROCESS_EVENT_TYPES,
  PROCESS_SCHEDULE_UNITS,
  TEAM_WORKSPACE_ROLES,
} from '@superapp/shared';
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
      // БЕЛЫЙ список командных ролей (как в ContactsService.assertReachable), а не
      // «все, кроме contractor»: fail-closed — новая роль в лестнице по чёрному списку
      // молча начала бы получать задачи и уведомления опубликованных процессов.
      role: { in: [...TEAM_WORKSPACE_ROLES] },
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
    icon: 'click',
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
    icon: 'clock',
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
    icon: 'plug',
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
    icon: 'broadcast',
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
      // Ф2 (sfflow#1): условие запуска — фильтр по полю данных события ДО старта (необязательно).
      { key: 'condField', label: 'Условие: поле события (необяз.)', kind: 'text', placeholder: 'напр. taskTitle', help: 'Запускать только если это поле события удовлетворяет условию. Пусто — запускать всегда.' },
      { key: 'condOp', label: 'Условие: оператор', kind: 'select', options: PROCESS_CONDITION_OPS.map((o) => ({ value: o.value, label: o.label })) },
      { key: 'condValue', label: 'Условие: значение', kind: 'text' },
      runAsField,
    ],
    configSchema: z.object({
      eventType: z.string().refine((v) => PROCESS_EVENT_TYPES.some((e) => e.value === v), 'Выберите событие'),
      condField: z.string().max(64).optional(),
      condOp: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty']).optional(),
      condValue: textField(200).optional(),
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
    icon: 'telegram',
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
    icon: 'tasks',
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
          // Оргструктура: руководитель инициатора по факту назначений (вершина → владелец)
          { value: 'initiator_manager', label: 'Руководитель инициатора' },
        ],
        help: 'Руководитель считается по оргструктуре в момент шага; если руководитель не найден — владелец организации.',
      },
      { key: 'assigneeUserId', label: 'Кто', kind: 'member', showIf: { field: 'assigneeMode', in: ['member'] } },
      { key: 'departmentId', label: 'Отдел', kind: 'department', showIf: { field: 'assigneeMode', in: ['department'] } },
      { key: 'dueInHours', label: 'Срок (часов с момента шага)', kind: 'number', placeholder: '24' },
    ],
    configSchema: z
      .object({
        title: textField(200, 1),
        description: textField(2000).optional(),
        assigneeMode: z.enum(['member', 'department', 'initiator', 'initiator_manager']),
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
      assigneeMode: 'member' | 'department' | 'initiator' | 'initiator_manager';
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

    let assigneeId: string;
    if (cfg.assigneeMode === 'initiator_manager') {
      // Единый словарь адресатов: руководитель инициатора по оргструктуре в момент шага;
      // вершина без руководителя → владелец (задача не остаётся без исполнителя).
      const audiences = ctx.deps.getService<AudiencesService>(AudiencesService as unknown as new (...args: unknown[]) => unknown);
      const ids = await audiences.resolve(
        [{ type: 'manager_of', id: ctx.startedById }],
        { workspaceId: ctx.workspaceId, initiatorId: ctx.startedById, selfId: ctx.startedById },
        { max: 50, onOverflow: 'truncate' },
      );
      if (!ids.length) throw new Error('Руководитель инициатора не найден: у организации нет ни структуры, ни владельца в команде');
      assigneeId = ids[0];
    } else {
      assigneeId = cfg.assigneeMode === 'initiator' ? ctx.startedById : cfg.assigneeUserId!;
    }
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
      { skipEnvironmentChecks: true, origin: 'process' }, // A4: не самозапускать процессы
    );
    return { kind: 'wait', patch: { taskId: task.id, assigneeId, deadlineAt }, output: { taskId: task.id } };
  },
};

/**
 * Решение человека: согласование · подпись · ознакомление.
 *
 * ПЕРЕВЕДЕНА НА `core/approvals` (2026-08-03). До этого нода держала человека
 * ВНУТРИ канваса: чтобы решить, надо было дойти до Организация → Процессы →
 * Входящие → найти запуск, и там висела одна строка текста — ни файла, ни суммы,
 * ни карточки. Теперь она заводит НАСТОЯЩУЮ заявку, и та попадает в общую стопку
 * «Ждут решения», в чат рич-карточкой и в журнал — ровно как соседняя нода
 * «Задача человеку» заводит настоящую задачу Задачника.
 *
 * Тип-ключ 'human.approval' сохранён: нарисованные маршруты продолжают работать.
 */
export const approvalNode: ProcessNodeProvider = {
  descriptor: {
    type: 'human.approval',
    title: 'Решение человека',
    description:
      'Отправляет предмет человеку на согласование, подпись или ознакомление. Решение принимается в общей стопке «Ждут решения» — из уведомления, с Главной или прямо из чата. Подстановки {{form.поле}}.',
    category: 'people',
    icon: 'checkCircle',
    tier: 'standard',
    outputs: [
      { key: 'approved', label: 'Согласовано' },
      { key: 'rejected', label: 'Отклонено' },
      // Третий исход добавлен к УЖЕ опубликованным нодам, поэтому необязательный:
      // без этого каждый нарисованный маршрут стал бы невалидным на первой же
      // проверке. Не подключён — токен уходит по «Отклонено» (см. fallback).
      { key: 'returned', label: 'На доработку', optional: true, fallback: 'rejected' },
    ],
    fields: [
      {
        key: 'kind',
        label: 'Что требуется',
        kind: 'select',
        options: [
          { value: 'approval', label: 'Согласовать' },
          { value: 'signature', label: 'Подписать' },
          { value: 'acknowledgement', label: 'Ознакомиться' },
        ],
        help: 'У ознакомления исход один: отказаться от ознакомления нельзя.',
      },
      { key: 'title', label: 'Что решаем', kind: 'text', required: true, placeholder: 'Покупка стиральной машины за {{form.budget}} ₸' },
      {
        key: 'assigneeMode',
        label: 'Кто решает',
        kind: 'select',
        required: true,
        options: [
          { value: 'member', label: 'Сотрудник' },
          { value: 'position', label: 'Должность (кто на ней сейчас)' },
          { value: 'department', label: 'Отдел' },
          // Ось `branch#member` давно проецируется в движок прав и объявлена
          // адресатом в APPROVAL_ASSIGNEE_TYPES — недоставало только режима
          // здесь, из-за чего «ознакомить филиал с приказом» было недостижимо
          // с канваса вовсе.
          { value: 'branch', label: 'Филиал' },
          { value: 'initiator', label: 'Инициатор процесса' },
          // КЭДО: работник знакомится с приказом О СЕБЕ, кто бы ни запускал маршрут.
          // До этого режима адресовать шаг стороне документа было нечем: инициатор
          // кадрового маршрута — кадровик, а не работник.
          { value: 'subject', label: 'Сторона документа (сотрудник в приказе)' },
          // Оргструктура (core/audiences): относительные адресаты — считаются в момент
          // активации шага; руководитель не найден → владелец организации.
          { value: 'initiator_manager', label: 'Руководитель инициатора' },
          { value: 'subject_manager', label: 'Руководитель стороны документа' },
          { value: 'branch_head', label: 'Руководитель объекта инициатора' },
        ],
        help: 'Относительные адресаты (руководитель…) считаются по оргструктуре в момент шага; руководитель не найден → владелец организации.',
      },
      { key: 'assigneeUserId', label: 'Кто', kind: 'member', showIf: { field: 'assigneeMode', in: ['member'] } },
      { key: 'positionId', label: 'Должность', kind: 'position', showIf: { field: 'assigneeMode', in: ['position'] } },
      { key: 'departmentId', label: 'Отдел', kind: 'department', showIf: { field: 'assigneeMode', in: ['department'] } },
      { key: 'branchId', label: 'Филиал', kind: 'branch', showIf: { field: 'assigneeMode', in: ['branch'] } },
      {
        key: 'rule',
        label: 'Сколько ответов нужно',
        kind: 'select',
        options: [
          { value: 'any', label: 'Любой из них' },
          { value: 'all', label: 'Каждый' },
        ],
        showIf: { field: 'assigneeMode', in: ['position', 'department', 'branch'] },
        help: 'Состав фиксируется снимком в момент, когда шаг дошёл до людей.',
      },
      {
        key: 'signatureLevel',
        label: 'Чем подписывать',
        kind: 'select',
        options: [
          { value: 'none', label: 'Достаточно нажать кнопку' },
          { value: 'pep', label: 'Простой подписью (код из SMS)' },
          { value: 'ecp', label: 'ЭЦП (ключ НУЦ РК)' },
        ],
        showIf: { field: 'kind', in: ['signature'] },
        help: 'Кадровые документы по ст. 33 ТК РК подписываются ЭЦП. Уровень обычно подставляется из вида документа.',
      },
      { key: 'dueInHours', label: 'Срок решения (часов)', kind: 'number', placeholder: '24' },
    ],
    configSchema: z
      .object({
        kind: z.enum(['approval', 'signature', 'acknowledgement']).optional(),
        /**
         * Чем шаг закрывается. `none`/пусто — нажатием кнопки (`internal`);
         * `pep`/`ecp` — настоящей подписью через core/sign, и обычный клик по
         * такому шагу отвергается кодом `approval_needs_signature`.
         */
        signatureLevel: z.enum(['none', 'pep', 'ecp']).optional(),
        title: textField(200, 1),
        assigneeMode: z.enum(['member', 'position', 'department', 'branch', 'initiator', 'subject', 'initiator_manager', 'subject_manager', 'branch_head']),
        assigneeUserId: z.string().uuid().optional(),
        positionId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        rule: z.enum(['any', 'all']).optional(),
        dueInHours: z.coerce.number().int().min(1).max(24 * 365).optional(),
      })
      .refine((c) => c.assigneeMode !== 'member' || !!c.assigneeUserId, {
        message: 'Выберите согласующего',
        path: ['assigneeUserId'],
      })
      .refine((c) => c.assigneeMode !== 'position' || !!c.positionId, {
        message: 'Выберите должность',
        path: ['positionId'],
      })
      .refine((c) => c.assigneeMode !== 'department' || !!c.departmentId, {
        message: 'Выберите отдел',
        path: ['departmentId'],
      })
      .refine((c) => c.assigneeMode !== 'branch' || !!c.branchId, {
        message: 'Выберите филиал',
        path: ['branchId'],
      }),
    auto: false, // токен спит, пока человек не решит — будит хук движка согласований
  },
  async run(ctx) {
    const cfg = ctx.config as {
      kind?: 'approval' | 'signature' | 'acknowledgement';
      signatureLevel?: 'none' | 'pep' | 'ecp';
      title: string;
      assigneeMode: 'member' | 'position' | 'department' | 'branch' | 'initiator' | 'subject' | 'initiator_manager' | 'subject_manager' | 'branch_head';
      assigneeUserId?: string;
      positionId?: string;
      departmentId?: string;
      branchId?: string;
      rule?: 'any' | 'all';
      dueInHours?: number;
    };
    const title = ctx.render(cfg.title);

    // «Сторона документа» — служебный ключ, который кладёт запуск маршрута
    // документа (`_subjectUserId`). Санитайзер внешних стартов такие ключи
    // отбрасывает; маршрут без стороны — честная ошибка, не пустой шаг.
    if ((cfg.assigneeMode === 'subject' || cfg.assigneeMode === 'subject_manager') && typeof ctx.variables._subjectUserId !== 'string') {
      throw new Error(
        'Шаг адресован стороне документа, но у запуска её нет: этот маршрут запускается отправкой документа с сотрудником-стороной',
      );
    }
    const assignee: { type: 'user' | 'position' | 'department' | 'branch' | 'manager_of' | 'branch_head_of'; id: string } =
      cfg.assigneeMode === 'initiator'
        ? { type: 'user', id: ctx.startedById }
        : cfg.assigneeMode === 'initiator_manager'
          ? { type: 'manager_of', id: ctx.startedById }
          : cfg.assigneeMode === 'subject_manager'
            ? { type: 'manager_of', id: ctx.variables._subjectUserId as string }
            : cfg.assigneeMode === 'branch_head'
              ? { type: 'branch_head_of', id: ctx.startedById }
        : cfg.assigneeMode === 'subject'
          ? { type: 'user', id: ctx.variables._subjectUserId as string }
          : cfg.assigneeMode === 'member'
            ? { type: 'user', id: cfg.assigneeUserId! }
            : cfg.assigneeMode === 'position'
              ? { type: 'position', id: cfg.positionId! }
              : cfg.assigneeMode === 'branch'
                ? { type: 'branch', id: cfg.branchId! }
                : { type: 'department', id: cfg.departmentId! };

    // Уволенный после публикации не должен получать решения (та же runtime-проверка,
    // что у задач и уведомлений). Для должности и отдела состав проверит сам движок
    // согласований, развернув снимок: пустой снимок — это честный тупик с уведомлением.
    if (assignee.type === 'user') await assertActiveMember(ctx, assignee.id, 'Согласующий');

    // Предмет решения. По умолчанию — САМ ЗАПУСК процесса: у него есть анкета, история
    // шагов и адрес. Но если маршрут ведёт предмет (документ отправлен на согласование),
    // решающий обязан видеть ЕГО — с файлом, номером и сторонами, а не строку «запуск
    // процесса». Служебные ключи ставит тот, кто запустил маршрут; санитайзер внешних
    // стартов их отбрасывает, поэтому подделать предмет чужим вебхуком нельзя.
    const subjectRefType = ctx.variables._subjectRefType;
    const subjectRefId = ctx.variables._subjectRefId;
    const subject =
      typeof subjectRefType === 'string' && typeof subjectRefId === 'string' && subjectRefId
        ? { refType: subjectRefType, refId: subjectRefId }
        : { refType: PROCESS_INSTANCE_REF_TYPE, refId: ctx.instanceId };

    const request = await ctx.deps.approvals.create(
      ctx.startedById,
      {
        refType: subject.refType,
        refId: subject.refId,
        steps: [
          {
            order: 0,
            kind: cfg.kind ?? 'approval',
            title,
            assigneeType: assignee.type,
            assigneeId: assignee.id,
            rule: assignee.type === 'user' ? 'any' : (cfg.rule ?? 'any'),
            dueInHours: cfg.dueInHours,
            // Требование настоящей подписи едет ВМЕСТЕ с шагом: проставленное после
            // создания, оно оставляло окно, в котором адресаты уже позваны, а шаг
            // ещё закрывался обычным кликом. Ставим только на шаг вида «Подписать»
            // — требовать ЭЦП от ознакомления значило бы просить ключ у того, от
            // кого ждут только прочтения.
            ...((cfg.kind ?? 'approval') === 'signature' &&
            (cfg.signatureLevel === 'pep' || cfg.signatureLevel === 'ecp')
              ? { requiredSignatureKind: cfg.signatureLevel === 'ecp' ? ('ecp' as const) : ('sms' as const) }
              : {}),
          },
        ],
      },
      // Непрозрачная для движка ссылка «кто ведёт»: по ней он вернёт нам управление.
      { type: PROCESS_ORIGIN_TYPE, ref: `${ctx.instanceId}:${ctx.step.id}` },
    );

    return {
      kind: 'wait',
      patch: {
        // Для одного человека сохраняем в шаге и его id: карточка запуска показывает
        // «кому назначено» карточкой человека. У должности и отдела адресатов много —
        // там это поле остаётся пустым, и лента шага говорит «решает <должность>».
        ...(assignee.type === 'user' ? { assigneeId: assignee.id } : {}),
        deadlineAt: deadlineFrom(cfg.dueInHours),
      },
      output: { kind: 'approval', title, approvalRequestId: request.id, assigneeKind: assignee.type },
    };
  },
};

/** Предмет заявки, когда маршрут ведёт не документ, а сам процесс */
export const PROCESS_INSTANCE_REF_TYPE = 'process_instance';
/** Ключ, по которому движок согласований находит хук возврата в Процессы */
export const PROCESS_ORIGIN_TYPE = 'process';

/** Пауза: токен ждёт заданное время, затем идёт дальше (таймер добивается кроном). */
export const delayNode: ProcessNodeProvider = {
  descriptor: {
    type: 'delay',
    title: 'Пауза',
    description: 'Останавливает процесс на заданное время, затем продолжает.',
    category: 'flow',
    icon: 'hourglass',
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
    icon: 'condition',
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

/** Сравнение значения с константой (нода «Если» + entry-conditions триггеров Ф2). */
export function evalCondition(raw: unknown, op: string, expected?: string): boolean {
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
    icon: 'bell',
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
    const title = cfg.title ? ctx.render(cfg.title) : '';
    const recipientId = cfg.to === 'initiator' ? ctx.startedById : cfg.userId;
    // Уведомление — best-effort (sfflow#3): любой сбой (нет заголовка/получателя, получатель
    // уволен) НЕ валит процесс — фиксируем в output и продолжаем по main.
    if (!title || !recipientId) return { kind: 'complete', output: { skipped: !title ? 'нет заголовка' : 'нет получателя' } };
    try {
      if (cfg.to === 'member') await assertActiveMember(ctx, recipientId, 'Получатель уведомления');
      await ctx.deps.notifications.notify(
        recipientId,
        'process.step.notify',
        { title, message: cfg.message ? ctx.render(cfg.message) : '' },
        { actionUrl: `/workspaces/${ctx.workspaceId}/processes/instances/${ctx.instanceId}` },
      );
      return { kind: 'complete', output: { recipientId } };
    } catch (err) {
      return { kind: 'complete', output: { skipped: (err as Error).message } };
    }
  },
};

/** Развилка: запускает несколько веток параллельно (fork). Каждое исходящее ребро = свой токен. */
export const splitNode: ProcessNodeProvider = {
  descriptor: {
    type: 'parallel.split',
    title: 'Развилка',
    description: 'Запускает несколько веток одновременно — все идут параллельно. Соедините выход с 2+ нодами.',
    category: 'flow',
    icon: 'split',
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
    icon: 'merge',
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

/**
 * Ф5 — «Перебрать список» (модель n8n Loop Over Items, последовательно): берёт массив из
 * источника и на КАЖДЫЙ элемент прогоняет ветку «Каждый» (элемент = {{item.поле}}); ветку
 * возвращают связью обратно в эту ноду; когда элементы кончились — идёт по «Готово».
 * Состояние (индекс) — в variables._loopIdx_<nodeId>; текущий элемент — в variables._item.
 */
export const loopEachNode: ProcessNodeProvider = {
  descriptor: {
    type: 'loop.each',
    title: 'Перебрать список',
    description:
      'Берёт список (результат прошлого шага/анкета) и прогоняет ветку «Каждый» на КАЖДЫЙ элемент — элемент доступен как {{item.поле}}. Ветку «Каждый» соедините связью ОБРАТНО в эту ноду. Когда элементы кончатся — процесс идёт по «Готово».',
    category: 'flow',
    icon: 'loop',
    tier: 'standard',
    outputs: [
      { key: 'loop', label: 'Каждый' },
      { key: 'done', label: 'Готово' },
    ],
    fields: [
      { key: 'source', label: 'Список (откуда)', kind: 'text', required: true, placeholder: '{{steps.kaspi.body.data}} / {{form.список}}', help: 'Ссылка на массив: результат прошлого шага или поле анкеты. Ветку «Каждый» верните связью в эту ноду.' },
      { key: 'maxIterations', label: 'Максимум элементов', kind: 'number', placeholder: '500' },
    ],
    configSchema: z.object({
      source: z.string().min(1).max(300),
      maxIterations: z.coerce.number().int().min(1).max(2000).optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { source: string; maxIterations?: number };
    const idxKey = `_loopIdx_${ctx.step.nodeId}`;
    const idx = Number((ctx.variables as Record<string, unknown>)[idxKey] ?? 0) || 0;
    const resolved = ctx.resolveValue(cfg.source);
    const list = Array.isArray(resolved) ? resolved : [];
    const cap = Math.min(Math.max(1, Number(cfg.maxIterations ?? 500)), 2000);
    const total = Math.min(list.length, cap);
    if (idx >= total) {
      // Элементы кончились → «Готово»; сбрасываем состояние (на случай внешнего повторного входа).
      return { kind: 'complete', outputKey: 'done', output: { count: total }, setVariables: { [idxKey]: 0, _item: null } };
    }
    // Выдаём текущий элемент в _item и идём по «Каждый»; индекс += 1 к следующему заходу.
    return { kind: 'complete', outputKey: 'loop', output: { index: idx }, setVariables: { [idxKey]: idx + 1, _item: list[idx] } };
  },
};

/**
 * Ф5 — «Задать данные» (n8n Edit Fields/Set): вычисляет поля и сохраняет их в данные
 * процесса (анкету) через setVariables. Строка «имя = выражение», напр. «итог = item.sum * 1.12».
 * Дальше поле доступно как {{form.имя}}. Выражения — безопасный вычислитель (без eval).
 */
export const setDataNode: ProcessNodeProvider = {
  descriptor: {
    type: 'data.set',
    title: 'Задать данные',
    description:
      'Вычисляет поля и сохраняет в данные процесса. Каждая строка: «имя = выражение», напр. «итог = item.sum * 1.12» или «привет = upper(item.name)». Дальше — {{form.имя}}.',
    category: 'flow',
    icon: 'variables',
    tier: 'standard',
    outputs: [{ key: 'main', label: '' }],
    fields: [
      { key: 'assignments', label: 'Поля (имя = выражение, по строке)', kind: 'textarea', required: true, placeholder: 'итог = item.sum * 1.12\nимя = upper(item.name)' },
    ],
    configSchema: z.object({ assignments: z.string().min(1).max(4000) }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { assignments: string };
    const setVariables: Record<string, unknown> = {};
    for (const line of cfg.assignments.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const key = s.slice(0, eq).trim();
      const expr = s.slice(eq + 1).trim();
      if (!/^[A-Za-z_]\w*$/.test(key) || !expr) continue; // имя поля — простой идентификатор
      setVariables[key] = ctx.resolveValue(expr);
    }
    return { kind: 'complete', output: { fields: Object.keys(setVariables) }, setVariables };
  },
};

/** Конец: терминальная нода — инстанс завершается. */
export const endNode: ProcessNodeProvider = {
  descriptor: {
    type: 'end',
    title: 'Конец',
    description: 'Завершает процесс.',
    category: 'flow',
    icon: 'finish',
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
  loopEachNode,
  setDataNode,
  notifyNode,
  endNode,
];
