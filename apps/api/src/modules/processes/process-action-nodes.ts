import { z } from 'zod';
import { DI_TOKENS } from '../../shared/di-tokens';
import type { NodeRunContext, NodeRunResult, ProcessNodeProvider } from './process-node.types';

/** Rich-card типы, у которых ЕСТЬ действия-кнопки (fin_* — снимки без действий, исключены). */
const ACTIONABLE_REF_TYPES = ['order', 'listing', 'crowdfunding', 'task', 'event'] as const;

// ============================================================
// Ф3 — ноды-действия: тонкие обёртки над платформенными сервисами через
// ctx.deps.getService(token) (ModuleRef). ВСЕ исполняются ОТ ИМЕНИ инициатора
// процесса (ctx.startedById): сервисы перепроверяют права ИМЕННО этого пользователя,
// поэтому процесс не может сделать больше, чем его инициатор (нет привилегий-эскалации).
// io: true — выполняются ВНЕ инстанс-лока (могут делать кросс-сервисную работу/сеть).
// Сбой → ветка «Ошибка» (self-catch), как у других io-нод.
// ============================================================

interface RichCardsLike {
  execute(userId: string, actionKey: string, ref: { type: string; id: string }, payload?: Record<string, unknown>): Promise<unknown>;
}
interface MessengerLike {
  openDm(userId: string, peerId: string): Promise<{ id: string }>;
  sendMessage(userId: string, chatId: string, content: string): Promise<unknown>;
}
interface StaffLike {
  assignPosition(actorId: string, workspaceId: string, targetUserId: string, data: { positionId: string; branchId?: string | null; status?: 'training' | 'certified' }): Promise<unknown>;
}
interface WorkspacesLike {
  updateMember(userId: string, workspaceId: string, targetUserId: string, data: { role: string }): Promise<unknown>;
}
interface ProcessesLike {
  startSubprocess(callerWorkspaceId: string, definitionId: string, actorUserId: string, variables: Record<string, unknown>, depth: number): Promise<string | null>;
}

const fail = (message: string): NodeRunResult => ({ kind: 'complete', outputKey: 'error', output: { error: message } });

// ------------------------------------------------------------
// 1. Действие с карточкой (core/rich-cards execute) — ~13 действий, права перепроверяются
// ------------------------------------------------------------
const RICH_ACTION_OPTIONS = [
  'order.confirm',
  'order.reject',
  'order.cancel',
  'order.refund',
  'task.accept',
  'task.return',
  'task.take',
  'event.rsvp_accept',
  'event.rsvp_decline',
  'event.rsvp_tentative',
  'listing.buy',
  'crowdfunding.contribute',
  'crowdfunding.withdraw',
];

export const richCardActionNode: ProcessNodeProvider = {
  descriptor: {
    type: 'action.richcard',
    category: 'service',
    icon: 'bolt',
    tier: 'standard',
    io: true,
    outputs: [
      { key: 'success' },
      { key: 'error' }
    ],
    fields: [
      { key: 'actionKey', kind: 'select', required: true, options: RICH_ACTION_OPTIONS },
      // Только типы с ДЕЙСТВИЯМИ (fin_transaction/fin_month — снимки без кнопок, их сюда
      // нельзя): держим options и configSchema.enum в синхроне из одного источника.
      { key: 'refType', kind: 'select', required: true, options: ACTIONABLE_REF_TYPES },
      { key: 'refId', kind: 'text', required: true },
      { key: 'payload', kind: 'textarea' }
    ],
    configSchema: z.object({
      actionKey: z.string().min(1).max(60),
      refType: z.enum(ACTIONABLE_REF_TYPES),
      refId: z.string().min(1).max(200),
      payload: z.string().max(4000).optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { actionKey: string; refType: string; refId: string; payload?: string };
    const refId = ctx.render(cfg.refId).trim();
    if (!refId) return fail('the object id is missing');
    let payload: Record<string, unknown> | undefined;
    if (cfg.payload) {
      try {
        const p = JSON.parse(ctx.render(cfg.payload));
        if (p && typeof p === 'object') payload = p as Record<string, unknown>;
      } catch {
        return fail('the extra parameters must be JSON');
      }
    }
    try {
      const rc = ctx.deps.getService<RichCardsLike>(DI_TOKENS.RichCardsService);
      await rc.execute(ctx.startedById, cfg.actionKey, { type: cfg.refType, id: refId }, payload);
      return { kind: 'complete', outputKey: 'success', output: { actionKey: cfg.actionKey, refId } };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// 2. Сообщение в чат (messenger) — в потоке И как инструмент агента (astool)
// ------------------------------------------------------------
async function sendMessageImpl(ctx: NodeRunContext, text: string): Promise<void> {
  const cfg = ctx.config as { to: 'member' | 'chat'; userId?: string; chatId?: string };
  const messenger = ctx.deps.getService<MessengerLike>(DI_TOKENS.MessengerService);
  let chatId = cfg.chatId ? ctx.render(cfg.chatId).trim() : '';
  if (cfg.to === 'member') {
    if (!cfg.userId) throw new Error('no recipient is chosen');
    const dm = await messenger.openDm(ctx.startedById, cfg.userId);
    chatId = dm.id;
  }
  if (!chatId) throw new Error('the chat is not set');
  await messenger.sendMessage(ctx.startedById, chatId, text);
}

export const messageSendNode: ProcessNodeProvider = {
  descriptor: {
    type: 'service.message',
    category: 'service',
    icon: 'messenger',
    tier: 'standard',
    io: true,
    outputs: [
      { key: 'success' },
      { key: 'error' },
      { key: 'astool', type: 'ai_tool' }
    ],
    fields: [
      { key: 'to', kind: 'select', required: true, options: ['member', 'chat'] },
      { key: 'userId', kind: 'member', showIf: { field: 'to', in: ['member'] } },
      { key: 'chatId', kind: 'text', showIf: { field: 'to', in: ['chat'] } },
      { key: 'text', kind: 'textarea' }
    ],
    configSchema: z
      .object({
        to: z.enum(['member', 'chat']),
        userId: z.string().uuid().optional(),
        chatId: z.string().max(200).optional(),
        text: z.string().max(4000).optional(),
      })
      .refine((c) => c.to !== 'member' || !!c.userId, { message: 'processes.validation.memberRequired', path: ['userId'] })
      .refine((c) => c.to !== 'chat' || !!c.chatId, { message: 'processes.validation.chatIdRequired', path: ['chatId'] }),
    auto: true,
    tool: {
      name: 'send_message',
      // Описание инструмента читает МОДЕЛЬ — оно остаётся английским.
      description: 'Send a message to a chat or a direct message (the recipient is set on the node; the agent writes the text).',
      schema: { type: 'object', properties: { text: { type: 'string', description: 'The message text' } }, required: ['text'] },
      async execute(ctx, input) {
        await sendMessageImpl(ctx, String(input.text ?? ''));
        return 'The message was sent';
      },
    },
  },
  async run(ctx) {
    const cfg = ctx.config as { text?: string };
    const text = cfg.text ? ctx.render(cfg.text) : '';
    if (!text) return fail('the text is empty (or connect the node to an agent as a tool)');
    try {
      await sendMessageImpl(ctx, text);
      return { kind: 'complete', outputKey: 'success', output: {} };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// 3. Назначить должность (staff) — инициатор должен быть Менеджер+ (assertStaffManage)
// ------------------------------------------------------------
export const staffAssignNode: ProcessNodeProvider = {
  descriptor: {
    type: 'staff.assign',
    category: 'people',
    icon: 'position',
    tier: 'standard',
    io: true,
    outputs: [
      { key: 'success' },
      { key: 'error' }
    ],
    fields: [
      { key: 'userId', kind: 'member', required: true },
      { key: 'positionId', kind: 'position', required: true },
      { key: 'branchId', kind: 'branch' }
    ],
    configSchema: z.object({
      userId: z.string().uuid(),
      positionId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { userId: string; positionId: string; branchId?: string };
    try {
      const staff = ctx.deps.getService<StaffLike>(DI_TOKENS.StaffService);
      await staff.assignPosition(ctx.startedById, ctx.workspaceId, cfg.userId, { positionId: cfg.positionId, branchId: cfg.branchId ?? null });
      return { kind: 'complete', outputKey: 'success', output: { userId: cfg.userId, positionId: cfg.positionId } };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// 4. Сменить роль сотрудника (workspaces) — инициатор должен быть Админ+ (assertCanManage)
// ------------------------------------------------------------
export const roleChangeNode: ProcessNodeProvider = {
  descriptor: {
    type: 'workspaces.role',
    category: 'people',
    icon: 'sliders',
    tier: 'standard',
    io: true,
    outputs: [
      { key: 'success' },
      { key: 'error' }
    ],
    fields: [
      { key: 'userId', kind: 'member', required: true },
      {
        key: 'role',
        kind: 'select',
        required: true,
        options: ['trainee', 'staff', 'manager', 'admin']
      }
    ],
    configSchema: z.object({ userId: z.string().uuid(), role: z.enum(['trainee', 'staff', 'manager', 'admin']) }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { userId: string; role: string };
    try {
      const ws = ctx.deps.getService<WorkspacesLike>(DI_TOKENS.WorkspacesService);
      await ws.updateMember(ctx.startedById, ctx.workspaceId, cfg.userId, { role: cfg.role });
      return { kind: 'complete', outputKey: 'success', output: { userId: cfg.userId, role: cfg.role } };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// 5. Запустить процесс (под-процесс) — та же организация, от инициатора, depth-guard
// ------------------------------------------------------------
export const startSubprocessNode: ProcessNodeProvider = {
  descriptor: {
    type: 'process.start',
    category: 'service',
    icon: 'processes',
    tier: 'standard',
    io: true,
    outputs: [
      { key: 'success' },
      { key: 'error' }
    ],
    fields: [
      { key: 'definitionId', kind: 'text', required: true },
      { key: 'input', kind: 'textarea' }
    ],
    configSchema: z.object({ definitionId: z.string().uuid(), input: z.string().max(8000).optional() }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { definitionId: string; input?: string };
    let input: Record<string, unknown> = {};
    if (cfg.input) {
      try {
        const p = JSON.parse(ctx.render(cfg.input));
        if (p && typeof p === 'object') input = p as Record<string, unknown>;
      } catch {
        return fail('the form values must be JSON');
      }
    }
    const depth = Number((ctx.variables as Record<string, unknown>)._subprocessDepth ?? 0) || 0;
    try {
      const processes = ctx.deps.getService<ProcessesLike>(DI_TOKENS.ProcessesService);
      const childId = await processes.startSubprocess(ctx.workspaceId, cfg.definitionId, ctx.startedById, input, depth + 1);
      return { kind: 'complete', outputKey: 'success', output: { childInstanceId: childId } };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// 6. Финансы: записать операцию — управленческий учёт в книгу ОРГАНИЗАЦИИ
// ------------------------------------------------------------
interface FinancesLike {
  recordOperationForBook(
    workspaceId: string,
    dto: { kind: 'expense' | 'income'; amount: number; categoryName: string; note?: string; actorUserId: string },
  ): Promise<{ transactionId: string; bookId: string }>;
}

export const financeRecordNode: ProcessNodeProvider = {
  descriptor: {
    type: 'finance.record',
    category: 'service',
    icon: 'receipt',
    tier: 'standard',
    io: true,
    outputs: [
      { key: 'success' },
      { key: 'error' }
    ],
    fields: [
      {
        key: 'kind',
        kind: 'select',
        required: true,
        options: ['expense', 'income']
      },
      { key: 'amount', kind: 'text', required: true },
      { key: 'categoryName', kind: 'text', required: true },
      { key: 'note', kind: 'textarea' }
    ],
    configSchema: z.object({
      kind: z.enum(['expense', 'income']),
      amount: z.string().min(1).max(120),
      categoryName: z.string().min(1).max(80),
      note: z.string().max(500).optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { kind: 'expense' | 'income'; amount: string; categoryName: string; note?: string };
    const raw = ctx.render(cfg.amount).replace(/\s/g, '').replace(',', '.');
    const tenge = Number(raw);
    if (!Number.isFinite(tenge) || tenge <= 0) return fail(`the amount could not be read: «${raw}»`);
    try {
      const finances = ctx.deps.getService<FinancesLike>(DI_TOKENS.FinancesService);
      const result = await finances.recordOperationForBook(ctx.workspaceId, {
        kind: cfg.kind,
        amount: Math.round(tenge * 100), // тенге → тиын
        categoryName: ctx.render(cfg.categoryName),
        note: cfg.note ? ctx.render(cfg.note) : undefined,
        actorUserId: ctx.startedById,
      });
      return { kind: 'complete', outputKey: 'success', output: result };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const ACTION_PROCESS_NODES: ProcessNodeProvider[] = [
  richCardActionNode,
  messageSendNode,
  staffAssignNode,
  roleChangeNode,
  startSubprocessNode,
  financeRecordNode,
];
