import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PROCESS_EVENT_TYPES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ProcessesService } from './processes.service';
import { evalCondition } from './process-builtin-nodes';

/**
 * Ф3 — роутер триггеров: ловит события платформы (EventBus) и стартует подписанные
 * процессы; добивает расписания (из крона); принимает вебхуки. Запуск процесса всегда
 * через ProcessesService.startInstanceProgrammatic (от имени runAsUserId).
 */
@Injectable()
export class ProcessTriggerRouter implements OnModuleInit {
  private readonly logger = new Logger(ProcessTriggerRouter.name);

  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private processes: ProcessesService,
  ) {}

  onModuleInit(): void {
    for (const evt of PROCESS_EVENT_TYPES) {
      this.events.on(evt.value).subscribe((event) => {
        void this.onEvent(evt.value, event.payload as Record<string, unknown>).catch((err) =>
          this.logger.error(`event trigger ${evt.value}: ${err?.message ?? err}`),
        );
      });
    }
  }

  /**
   * Ф4: реестр «префикс события → резолвер организации» (у части payload нет workspaceId —
   * резолвим по сущности). Новое семейство событий = +1 запись здесь, ядро не трогаем.
   */
  private readonly workspaceResolvers: { prefix: string; resolve: (p: Record<string, unknown>) => Promise<string | null> }[] = [
    // workspace.* (incl. member.removed / position.* / invitation.accepted) — воркспейс в payload.
    { prefix: 'workspace.', resolve: async (p) => (p.workspaceId as string) ?? null },
    { prefix: 'task.', resolve: async (p) => {
        const taskId = p.taskId as string | undefined;
        if (!taskId) return null;
        const task = await this.db.task.findUnique({ where: { id: taskId }, select: { workspaceId: true } });
        return task?.workspaceId ?? null;
      } },
    // shop.order.* — воркспейс только у заказов НА МАГАЗИНЕ КОМПАНИИ (ownerType='workspace');
    // личные магазины воркспейса не имеют → триггер не срабатывает (return null).
    { prefix: 'shop.order.', resolve: async (p) => {
        const orderId = p.orderId as string | undefined;
        if (!orderId) return null;
        const order = await this.db.order.findUnique({ where: { id: orderId }, select: { shopId: true } });
        if (!order) return null;
        const shop = await this.db.shop.findUnique({ where: { id: order.shopId }, select: { ownerType: true, ownerId: true } });
        return shop?.ownerType === 'workspace' ? shop.ownerId : null;
      } },
    // finance.transaction.created — воркспейс несёт сам payload, НО только для книг
    // организации (ownerType='workspace'); личные операции идут с workspaceId=undefined →
    // return null (триггеров нет). Записи, порождённые процессом (source='process'),
    // отсекаются анти-runaway-гвардом в onEvent ещё до резолва.
    { prefix: 'finance.', resolve: async (p) => (p.workspaceId as string) ?? null },
  ];

  /** Определяем организацию события через реестр резолверов (по префиксу типа). */
  private async resolveWorkspace(eventType: string, payload: Record<string, unknown>): Promise<string | null> {
    for (const r of this.workspaceResolvers) {
      if (eventType.startsWith(r.prefix)) return r.resolve(payload);
    }
    return null;
  }

  private async onEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    // Анти-runaway (A4): событие, ПОРОЖДЁННОЕ самим движком, не перезапускает процессы —
    // иначе нода «Задача» + триггер «task.created»/«task.completed» = бесконечное
    // самоусиление. (1) маркер source='process' закрывает гонку task.created (событие
    // эмитится в createTask ДО записи taskId в шаг); (2) для task.completed (taskId давно
    // записан) — надёжная сверка «это задача-шаг процесса».
    if (payload.source === 'process') return;
    const workspaceId = await this.resolveWorkspace(eventType, payload);
    if (!workspaceId) return; // личное событие (не из организации) — триггеров нет
    if (eventType.startsWith('task.')) {
      const taskId = payload.taskId as string | undefined;
      if (taskId) {
        const isProcessStep = await this.db.processStepRun.findFirst({ where: { taskId }, select: { id: true } });
        if (isProcessStep) return; // self-событие движка — не триггерим
      }
    }
    const triggers = await this.db.processTrigger.findMany({
      where: { workspaceId, type: 'event', enabled: true, eventType, definition: { status: 'active' } },
    });
    for (const t of triggers) {
      try {
        const tcfg = (t.config ?? {}) as { nodeId?: string; condField?: string; condOp?: string; condValue?: string };
        // Ф2 (sfflow#1): entry-condition — фильтр по полю данных события ДО старта.
        if (tcfg.condField && tcfg.condOp && !evalCondition(payload[tcfg.condField], tcfg.condOp, tcfg.condValue)) continue;
        const id = await this.processes.startInstanceProgrammatic(t.definitionId, t.runAsUserId, payload, 'event', tcfg.nodeId);
        if (id) await this.db.processTrigger.update({ where: { id: t.id }, data: { lastRunAt: new Date() } });
      } catch (err) {
        this.logger.error(`fire event trigger ${t.id}: ${(err as Error).message}`);
      }
    }
  }

  /** Кроновый проход по расписаниям (под Redis-локом снаружи). */
  async runDueSchedules(): Promise<void> {
    const now = new Date();
    const due = await this.db.processTrigger.findMany({
      // A11: только ОПУБЛИКОВАННЫЕ (currentVersionId) — иначе расписание неопубликованного
      // процесса молча прокручивало бы nextRunAt (пропуская окна), а старт всё равно = null.
      where: { type: 'schedule', enabled: true, nextRunAt: { lte: now }, definition: { status: 'active', currentVersionId: { not: null } } },
      take: 200,
    });
    for (const t of due) {
      const cfg = (t.config ?? {}) as { everyValue?: number; everyUnit?: string };
      const ms = (cfg.everyValue ?? 1) * (cfg.everyUnit === 'days' ? 86_400_000 : 3_600_000);
      // Сначала переносим nextRunAt (защита от двойного запуска при гонке), потом стартуем.
      const claimed = await this.db.processTrigger.updateMany({
        where: { id: t.id, nextRunAt: t.nextRunAt },
        data: { nextRunAt: new Date(now.getTime() + ms), lastRunAt: now },
      });
      if (claimed.count === 0) continue;
      try {
        const nodeId = ((t.config ?? {}) as { nodeId?: string }).nodeId;
        await this.processes.startInstanceProgrammatic(t.definitionId, t.runAsUserId, {}, 'schedule', nodeId);
      } catch (err) {
        this.logger.error(`fire schedule trigger ${t.id}: ${(err as Error).message}`);
      }
    }
  }

  /** Публичный вебхук: тело запроса → анкета процесса. Возвращает id инстанса или null. */
  async fireWebhook(token: string, body: Record<string, unknown>): Promise<string | null> {
    const trigger = await this.db.processTrigger.findUnique({ where: { webhookToken: token } });
    if (!trigger || !trigger.enabled || trigger.type !== 'webhook') return null;
    const nodeId = ((trigger.config ?? {}) as { nodeId?: string }).nodeId;
    const id = await this.processes.startInstanceProgrammatic(trigger.definitionId, trigger.runAsUserId, body ?? {}, 'webhook', nodeId);
    if (id) await this.db.processTrigger.update({ where: { id: trigger.id }, data: { lastRunAt: new Date() } });
    return id;
  }

  /**
   * Публичный приёмник Telegram-апдейтов: входящее сообщение боту → старт процесса с
   * триггер-ноды (текст/чат/отправитель → анкета). Не-текстовые апдейты тихо игнорируются.
   */
  async fireTelegram(token: string, update: Record<string, unknown>): Promise<string | null> {
    const trigger = await this.db.processTrigger.findUnique({ where: { webhookToken: token } });
    if (!trigger || !trigger.enabled || trigger.type !== 'telegram') return null;

    const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
    const text = typeof msg?.text === 'string' ? msg.text : null;
    const chat = msg?.chat as { id?: unknown } | undefined;
    if (!msg || text === null || chat?.id == null) return null; // не текстовое сообщение — игнор (200)

    const from = (msg.from ?? {}) as Record<string, unknown>;
    const first = typeof from.first_name === 'string' ? from.first_name : '';
    const last = typeof from.last_name === 'string' ? from.last_name : '';
    const uname = typeof from.username === 'string' ? from.username : '';
    const variables = {
      text,
      chatId: String(chat.id),
      fromId: from.id != null ? String(from.id) : '',
      fromName: [first, last].filter(Boolean).join(' ') || uname || 'Гость',
      messageId: msg.message_id != null ? String(msg.message_id) : '',
    };
    const nodeId = ((trigger.config ?? {}) as { nodeId?: string }).nodeId;
    const id = await this.processes.startInstanceProgrammatic(trigger.definitionId, trigger.runAsUserId, variables, 'telegram', nodeId);
    if (id) await this.db.processTrigger.update({ where: { id: trigger.id }, data: { lastRunAt: new Date() } });
    return id;
  }
}
