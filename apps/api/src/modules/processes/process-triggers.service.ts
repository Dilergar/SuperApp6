import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PROCESS_EVENT_TYPES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ProcessesService } from './processes.service';

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

  /** Определяем организацию события (у части payload нет workspaceId — резолвим по сущности). */
  private async resolveWorkspace(eventType: string, payload: Record<string, unknown>): Promise<string | null> {
    if (eventType.startsWith('workspace.')) return (payload.workspaceId as string) ?? null;
    if (eventType.startsWith('task.')) {
      const taskId = payload.taskId as string | undefined;
      if (!taskId) return null;
      const task = await this.db.task.findUnique({ where: { id: taskId }, select: { workspaceId: true } });
      return task?.workspaceId ?? null;
    }
    return null;
  }

  private async onEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const workspaceId = await this.resolveWorkspace(eventType, payload);
    if (!workspaceId) return; // личное событие (не из организации) — триггеров нет
    const triggers = await this.db.processTrigger.findMany({
      where: { workspaceId, type: 'event', enabled: true, config: { path: ['eventType'], equals: eventType }, definition: { status: 'active' } },
    });
    for (const t of triggers) {
      try {
        const nodeId = ((t.config ?? {}) as { nodeId?: string }).nodeId;
        const id = await this.processes.startInstanceProgrammatic(t.definitionId, t.runAsUserId, payload, 'event', nodeId);
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
      where: { type: 'schedule', enabled: true, nextRunAt: { lte: now }, definition: { status: 'active' } },
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
