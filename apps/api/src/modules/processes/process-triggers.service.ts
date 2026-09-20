import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  PROCESS_EVENT_TYPES,
  TEAM_WORKSPACE_ROLES,
  WORKSPACE_ROLE_RANK,
  type WorkspaceRole,
} from '@superapp/shared';
import { SOURCE_LOCALE } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ProcessesService } from './processes.service';
import { evalCondition } from './process-builtin-nodes';
import { hashWebhookToken, isHashedWebhookToken, telegramSecretMatches, webhookTokenCtx } from './process-crypto';
import { KeysEnvelopeService } from '../../core/keys/keys.envelope.service';
import { KeysMacService } from '../../core/keys/keys.mac.service';
import { JobDiscardError, JobsRegistry } from '../../core/jobs/jobs.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { IdempotencyInboxService } from '../../core/idempotency/idempotency.inbox.service';

/**
 * Ф3 — роутер триггеров: ловит события платформы (EventBus) и стартует подписанные
 * процессы; добивает расписания (из крона); принимает вебхуки. Запуск процесса всегда
 * через ProcessesService.startInstanceProgrammatic (от имени runAsUserId).
 */
const WEBHOOK_TOKENS_BACKFILL_JOB = 'processes.webhookTokens.backfill';

@Injectable()
export class ProcessTriggerRouter implements OnModuleInit {
  private readonly logger = new Logger(ProcessTriggerRouter.name);

  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private processes: ProcessesService,
    private i18n: I18nService,
    private keys: KeysEnvelopeService,
    private mac: KeysMacService,
    private jobsRegistry: JobsRegistry,
    private jobs: JobsService,
    private inbox: IdempotencyInboxService,
  ) {}

  onModuleInit(): void {
    // Бэкфилл токенов вебхуков прошлой эпохи (сырой токен в unique-колонке → хеш + envelope):
    // джоб на каждом старте, идемпотентный — без legacy-строк ничего не делает.
    this.jobsRegistry.register(WEBHOOK_TOKENS_BACKFILL_JOB, () => this.backfillWebhookTokens(), { maxAttempts: 5 });
    void this.jobs
      .enqueue(null, { type: WEBHOOK_TOKENS_BACKFILL_JOB, payload: {}, uniqueKey: 'boot', runAt: new Date(Date.now() + 15_000) })
      .catch((err) => this.logger.warn(`webhook tokens backfill enqueue failed: ${(err as Error).message}`));
    for (const evt of PROCESS_EVENT_TYPES) {
      this.events.on(evt).subscribe((event) => {
        void this.onEvent(evt, event.payload as Record<string, unknown>).catch((err) =>
          this.logger.error(`event trigger ${evt}: ${err?.message ?? err}`),
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

  /**
   * Гейт «от имени» на МОМЕНТ СРАБАТЫВАНИЯ. Строка триггера переживает роли, поэтому
   * одной проверки при публикации мало:
   *  (1) исполнитель всё ещё действующий сотрудник (не Подрядчик) — уволенный не запускает;
   *  (2) его ТЕКУЩИЙ ранг не выше ранга публикатора — повышение ПОСЛЕ публикации не
   *      превращает старый триггер в лестницу к чужим правам.
   * Один индексированный запрос на срабатывание; рядом и так идут чтение определения,
   * чтение версии, подсчёт бегущих инстансов и полный старт — это шум.
   */
  private async runAsAllowed(t: {
    id: string;
    workspaceId: string;
    runAsUserId: string;
    config: unknown;
  }): Promise<boolean> {
    const rows = await this.db.userRole.findMany({
      where: {
        context: 'workspace',
        tenantId: t.workspaceId,
        userId: t.runAsUserId,
        isActive: true,
        // Белый список командных ролей: «от имени» одалживает права живому сотруднику,
        // и по чёрному списку любая будущая не-командная роль молча получила бы этот
        // мостик. Сравнение с publisherRank ниже — отдельная проверка, она остаётся ранговой.
        role: { in: [...TEAM_WORKSPACE_ROLES] },
      },
      select: { role: true },
    });
    if (rows.length === 0) {
      this.logger.warn(`trigger ${t.id}: the runAs user ${t.runAsUserId} is no longer an employee — the run is skipped`);
      return false;
    }
    const publisherRank = Number((t.config as { publisherRank?: number } | null)?.publisherRank ?? 0);
    // Строки, опубликованные ДО появления publisherRank, ранга не несут — проверяем
    // только членство. Без этого фолбэка раскатка молча погасила бы все живые триггеры.
    if (!publisherRank) return true;
    const rank = Math.max(...rows.map((r) => WORKSPACE_ROLE_RANK[r.role as WorkspaceRole] ?? 0));
    if (rank > publisherRank) {
      this.logger.warn(
        `trigger ${t.id}: the runAs user ${t.runAsUserId} was promoted after the publication (${rank} > ${publisherRank}) — ` +
          'the run is skipped, republish the process',
      );
      return false;
    }
    return true;
  }

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
        if (!(await this.runAsAllowed(t))) continue;
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
      // Гейт «от имени» — ДО claim: иначе заблокированное расписание молча сжигало бы
      // своё окно, прокручивая nextRunAt без единого запуска.
      if (!(await this.runAsAllowed(t))) continue;
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
    const trigger = await this.findByRawToken(token);
    if (!trigger || !trigger.enabled || trigger.type !== 'webhook') return null;
    if (!(await this.runAsAllowed(trigger))) return null;
    const nodeId = ((trigger.config ?? {}) as { nodeId?: string }).nodeId;
    const id = await this.processes.startInstanceProgrammatic(trigger.definitionId, trigger.runAsUserId, body ?? {}, 'webhook', nodeId);
    if (id) await this.db.processTrigger.update({ where: { id: trigger.id }, data: { lastRunAt: new Date() } });
    return id;
  }

  /**
   * Публичный приёмник Telegram-апдейтов: входящее сообщение боту → старт процесса с
   * триггер-ноды (текст/чат/отправитель → анкета). Не-текстовые апдейты тихо игнорируются.
   */
  async fireTelegram(token: string, update: Record<string, unknown>, secretHeader?: string): Promise<string | null> {
    const trigger = await this.findByRawToken(token);
    if (!trigger || !trigger.enabled || trigger.type !== 'telegram') return null;
    // Вебхук зарегистрирован с secret_token → заголовок обязан совпасть (иначе апдейт
    // подделан). Регистрации до движка ключей (webhookSecretAt = NULL) принимаются без
    // заголовка, пока публикация не перерегистрирует бота с секретом.
    if (trigger.webhookSecretAt && !(await telegramSecretMatches(this.mac, token, secretHeader))) {
      this.logger.warn(`telegram update for trigger ${trigger.id} rejected: bad secret_token`);
      return null;
    }
    if (!(await this.runAsAllowed(trigger))) return null;

    // Секрет проверен — только теперь апдейт вправе попасть в «входящий ящик».
    // Telegram повторяет доставку, пока не увидит 2xx, и без дедупа один и тот же
    // `update_id` запускал бы процесс столько раз, сколько было повторов.
    const updateId = update.update_id;
    const inboxRef =
      typeof updateId === 'number' || typeof updateId === 'string'
        ? { source: 'telegram', account: trigger.id, eventId: String(updateId) }
        : null;
    if (inboxRef && !(await this.inbox.firstTime(inboxRef))) return null; // редоставка

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
      // Имя пришло из ЧУЖОЙ системы (Telegram) — это данные. Его отсутствие —
      // слово продукта, и оно едет КЛЮЧОМ: фраза застыла бы в языке вебхука.
      ...(([first, last].filter(Boolean).join(' ') || uname)
        ? { fromName: [first, last].filter(Boolean).join(' ') || uname }
        : { fromNameKey: 'common.labels.someone' }),
      messageId: msg.message_id != null ? String(msg.message_id) : '',
    };
    const nodeId = ((trigger.config ?? {}) as { nodeId?: string }).nodeId;
    let id: string | null;
    try {
      id = await this.processes.startInstanceProgrammatic(trigger.definitionId, trigger.runAsUserId, variables, 'telegram', nodeId);
    } catch (err) {
      // Запуск живёт не в одной транзакции с отметкой: не сняв её, мы потеряли бы апдейт
      if (inboxRef) await this.inbox.forget(inboxRef).catch(() => undefined);
      throw err;
    }
    if (id) await this.db.processTrigger.update({ where: { id: trigger.id }, data: { lastRunAt: new Date() } });
    return id;
  }

  /** Триггер по сырому токену URL: сначала хеш (новые строки), затем сама строка (legacy до бэкфилла). */
  private async findByRawToken(token: string) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
    const byHash = await this.db.processTrigger.findUnique({ where: { webhookToken: hashWebhookToken(token) } });
    if (byHash) return byHash;
    if (isHashedWebhookToken(token)) return null;
    return this.db.processTrigger.findUnique({ where: { webhookToken: token } });
  }

  /** Legacy-строки: сырой токен → envelope + хеш (батчами, идемпотентно). */
  async backfillWebhookTokens(): Promise<void> {
    let done = 0;
    for (;;) {
      const rows = await this.db.processTrigger.findMany({
        where: { webhookToken: { not: null }, webhookTokenEnc: null },
        select: { id: true, workspaceId: true, webhookToken: true },
        take: 200,
      });
      const legacy = rows.filter((r) => r.webhookToken && !isHashedWebhookToken(r.webhookToken));
      if (!legacy.length) break;
      for (const r of legacy) {
        const raw = r.webhookToken!;
        let enc: string;
        try {
          enc = await this.keys.encrypt({ type: 'workspace', id: r.workspaceId }, webhookTokenCtx(r.workspaceId), raw);
        } catch (err) {
          throw new JobDiscardError(`webhook token backfill ${r.id}: ${(err as Error).message}`);
        }
        await this.db.processTrigger.updateMany({ where: { id: r.id, webhookToken: raw }, data: { webhookToken: hashWebhookToken(raw), webhookTokenEnc: enc } });
        done++;
      }
      if (legacy.length < 200) break;
    }
    if (done) this.logger.log(`webhook tokens backfilled: ${done}`);
  }
}
