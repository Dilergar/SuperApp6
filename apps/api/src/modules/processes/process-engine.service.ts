import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PROCESS_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';
import { ProcessNodeRegistry } from './process-node.registry';
import { parserInstruction, resolveLlmConfig, runAgentWithCluster } from './process-ai-nodes';
import { evalExpression } from './process-expression';
import type { AgentCluster, AgentTool, CompiledPlan, NodeRunContext, NodeRunResult } from './process-node.types';

// 'consumed' — терминальный токен («Конец») погашен, НО инстанс не завершаем: соседние
// ветки живут (A2 branch-local); финал наступает, когда все токены слились/дошли (drain).
type AdvanceOutcome = 'advanced' | 'consumed' | 'failed' | 'noop';

/** Минимум полей инстанса/шага, нужный движку (полная строка Prisma им удовлетворяет). */
type InstanceLite = { id: string; versionId: string; workspaceId: string; startedById: string; variables: unknown; definitionId: string };
type StepLite = { id: string; nodeId: string; joinArrivals: number; leasedUntil: Date | null; activated: boolean };

/**
 * Token-движок на строках БД (модель Conductor/Camunda, стиль кода — кошелёк):
 * ProcessInstance = «где процесс», ProcessStepRun = токены; переходы — status-guarded
 * updateMany в транзакции (двойной приёмки/двойного продвижения не бывает); ожидания
 * «спят» строками (рестарт сервера ничего не теряет); крон добивает зависшее.
 */
@Injectable()
export class ProcessEngineService {
  private readonly logger = new Logger(ProcessEngineService.name);
  /** versionId → план: опубликованные версии неизменяемы, кэш безопасен. */
  private readonly planCache = new Map<string, CompiledPlan>();
  /** instanceId → стабильные имена (инициатор/процесс): buildContext не делает 2 запроса
   *  на КАЖДУЮ ноду (P1). Имена на жизнь инстанса неизменны (display-only). Cap как у planCache. */
  private readonly instanceMetaCache = new Map<string, { initiatorName: string; definitionName: string }>();

  // Инстанс-лок держится ТОЛЬКО поверх bookkeeping (выбор/коммит шага) — не поверх I/O
  // (P3), поэтому TTL короткий. Внешний I/O (HTTP/LLM) идёт БЕЗ лока под арендой шага.
  private static readonly KICK_LOCK_TTL_MS = 30_000;
  // Аренда I/O-шага: пока идёт внешний вызов, другой kick/крон его не переисполнит, даже
  // если инстанс-лок протух. Должна с запасом покрывать самый долгий вызов (агент-цикл).
  private static readonly STEP_LEASE_MS = 200_000;

  private kickKey(instanceId: string): string {
    return `process:kick:${instanceId}`;
  }

  constructor(
    private db: DatabaseService,
    private registry: ProcessNodeRegistry,
    private redis: RedisService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private tasks: TasksService,
    private moduleRef: ModuleRef,
  ) {}

  // ---------------------------------------------------------------
  // Запуск
  // ---------------------------------------------------------------

  async startInstance(params: {
    definitionId: string;
    versionId: string;
    workspaceId: string;
    starterId: string;
    variables: Record<string, unknown>;
    plan: CompiledPlan;
    triggerType?: 'manual' | 'event' | 'schedule' | 'webhook' | 'telegram';
    /** Триггер-нода, с которой стартует токен (по умолчанию — «Запуск вручную»/startNodeId). */
    entryNodeId?: string;
  }): Promise<string> {
    const { plan } = params;
    this.cachePlan(params.versionId, plan);

    // Точка входа: фиксированного «Старт» нет — стартуем со сработавшего триггера.
    const entryNodeId = params.entryNodeId || plan.startNodeId;
    const entryNode = plan.nodes[entryNodeId];
    if (!entryNode) throw new BadRequestException('У процесса нет точки входа (триггера)');

    const instance = await this.db.$transaction(async (tx) => {
      const created = await tx.processInstance.create({
        data: {
          definitionId: params.definitionId,
          versionId: params.versionId,
          workspaceId: params.workspaceId,
          startedById: params.starterId,
          triggerType: params.triggerType ?? 'manual',
          variables: params.variables as object,
          status: 'running',
        },
      });
      await tx.processStepRun.create({
        data: {
          instanceId: created.id,
          nodeId: entryNodeId,
          nodeType: entryNode.type,
          label: entryNode.label, // P7: снимок подписи (журнал не парсит документ)
          status: 'active',
        },
      });
      return created;
    });

    this.events.emit(
      'process.started',
      { instanceId: instance.id, definitionId: params.definitionId, workspaceId: params.workspaceId, startedById: params.starterId },
      'processes',
    );

    await this.kick(instance.id);
    return instance.id;
  }

  // ---------------------------------------------------------------
  // Главный цикл: гоним токен по авто-нодам, активируем ожидающие
  // ---------------------------------------------------------------

  /**
   * Продвигает инстанс, пока есть что делать. Каждый проход (kickOnce) берёт КОРОТКИЙ
   * инстанс-лок для bookkeeping; ноды внешнего I/O (HTTP/LLM/KZ) исполняются ВНЕ лока под
   * арендой шага (P3 — лок не висит поверх сети). Дешёвые ноды — целиком под локом (как
   * раньше). Проигравший лок просто уходит (активный kick доведёт).
   */
  async kick(instanceId: string): Promise<void> {
    for (let i = 0; i < PROCESS_LIMITS.maxAutoChain; i++) {
      const goOn = await this.kickOnce(instanceId);
      if (!goOn) return;
    }
    this.logger.warn(`kick(${instanceId}): исчерпан бюджет авто-цепочки — продолжит крон`);
  }

  /**
   * Один шаг цикла. Фаза 1 (под локом): выбрать готовый шаг — дешёвый выполнить тут же,
   * I/O-ноду арендовать. Фаза 2 (БЕЗ лока): внешний I/O. Фаза 3 (под локом): коммит.
   * @returns true — крутить цикл дальше; false — стоп (пусто/лок занят/инстанс не бежит).
   */
  private async kickOnce(instanceId: string): Promise<boolean> {
    type PickResult =
      | { stop: true }
      | { again: true }
      | { io: { instance: InstanceLite; plan: CompiledPlan; step: StepLite } };
    const picked = await this.redis.withLock<PickResult>(this.kickKey(instanceId), ProcessEngineService.KICK_LOCK_TTL_MS, async () => {
      const instance = await this.db.processInstance.findUnique({ where: { id: instanceId } });
      if (!instance || instance.status !== 'running') return { stop: true };

      const plan = await this.getPlan(instance.versionId);
      if (!plan) {
        await this.failInstance(instanceId, null, 'План версии не найден');
        return { stop: true };
      }

      const now = new Date();
      const activeSteps = await this.db.processStepRun.findMany({
        where: { instanceId, status: 'active' },
        orderBy: { startedAt: 'asc' },
      });
      if (activeSteps.length === 0) {
        // Все токены дошли до «Конца»/слились — процесс завершён (A2: branch-local end).
        await this.completeInstanceIfDrained(instanceId);
        return { stop: true };
      }

      // Готово к исполнению: авто-нода ИЛИ неактивированное ожидание, НЕ занятое арендой.
      const runnable = activeSteps.find((s) => {
        if (s.leasedUntil && s.leasedUntil.getTime() > now.getTime()) return false; // исполняется другим kick
        const node = plan.nodes[s.nodeId];
        if (!node) return true; // упадёт в failInstance с внятной ошибкой
        return node.auto || !s.activated;
      });
      if (!runnable) {
        // Готовых шагов нет. Но, возможно, слияние уже не дождётся уведённой ветки
        // (condition/свой «Конец») — добиваем его сразу (A1), чтобы не висеть до крона.
        const fired = await this.tryForceFireStuckJoin(instance.id, plan, activeSteps);
        return fired ? { again: true } : { stop: true };
      }

      const node = plan.nodes[runnable.nodeId];
      const isIo = !!(node && this.registry.get(node.type)?.descriptor.io);
      if (!isIo) {
        // Дешёвая нода (условие/уведомление/человеческая-задача/слияние/пауза/конец) —
        // выполняем целиком под локом, как раньше (bookkeeping без сети — быстро).
        await this.executeStepLocked(instance, plan, runnable);
        return { again: true };
      }

      // I/O-нода: аренда → исполнение вне лока. WHERE-гард на свободную аренду от гонок.
      const leaseUntil = new Date(now.getTime() + ProcessEngineService.STEP_LEASE_MS);
      const leased = await this.db.processStepRun.updateMany({
        where: { id: runnable.id, status: 'active', OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
        data: { leasedUntil: leaseUntil },
      });
      if (leased.count === 0) return { again: true }; // арендовал другой между find и update
      return { io: { instance, plan, step: runnable } };
    });

    if (!picked) return false; // лок держит другой kick — уходим (он доведёт цепочку)
    if ('stop' in picked) return false;
    if ('again' in picked) return true;
    // Фаза 2 (БЕЗ лока) + Фаза 3 (коммит под локом).
    await this.runIoStep(picked.io.instance, picked.io.plan, picked.io.step);
    return true;
  }

  /** Дешёвая нода: выполнить и закоммитить ПОД уже удерживаемым инстанс-локом (Фаза 1). */
  private async executeStepLocked(instance: InstanceLite, plan: CompiledPlan, step: StepLite): Promise<void> {
    const node = plan.nodes[step.nodeId];
    const provider = node ? this.registry.get(node.type) : undefined;
    if (!node || !provider) {
      await this.failInstance(instance.id, step.id, `Неизвестная нода «${step.nodeId}»`);
      return;
    }
    // allowRetry=false: повтор с паузой под локом недопустим (держал бы инстанс-лок).
    const outcome = await this.runNodeWithPolicy(instance, plan, step, node, false);
    if ('fail' in outcome) {
      await this.failInstance(instance.id, step.id, outcome.fail);
      return;
    }
    try {
      await this.commitResult(instance, plan, step, outcome.result);
    } catch (err) {
      await this.failInstance(instance.id, step.id, `${node.label}: ${err instanceof Error ? err.message : 'Ошибка выполнения ноды'}`);
    }
  }

  /** I/O-нода (P3): Фаза 2 — provider.run() БЕЗ лока (внешний HTTP/LLM); Фаза 3 — коммит под локом. */
  private async runIoStep(instance: InstanceLite, plan: CompiledPlan, step: StepLite): Promise<void> {
    const node = plan.nodes[step.nodeId];
    const provider = node ? this.registry.get(node.type) : undefined;
    if (!node || !provider) {
      await this.failInstance(instance.id, step.id, `Неизвестная нода «${step.nodeId}»`);
      return;
    }
    // allowRetry=true: retry (с паузой) идёт ВНЕ лока — не держит инстанс-лок (P3/n8n#3).
    const outcome = await this.runNodeWithPolicy(instance, plan, step, node, true);
    // Коммит под локом (bookkeeping — быстро). withInstanceLock ретраит захват (сигнал не теряем).
    const committed = await this.withInstanceLock(instance.id, async () => {
      if ('fail' in outcome) {
        await this.failInstance(instance.id, step.id, outcome.fail);
        return;
      }
      try {
        await this.commitResult(instance, plan, step, outcome.result);
      } catch (err) {
        await this.failInstance(instance.id, step.id, `${node.label}: ${err instanceof Error ? err.message : 'Ошибка выполнения ноды'}`);
      }
    });
    if (!committed) {
      // Экстремально редко (лок держится лишь на bookkeeping): аренда истечёт → крон
      // переисполнит ноду. Для не-идемпотентного I/O — as-good-as-it-gets (n8n-семантика).
      this.logger.warn(`runIoStep(${instance.id}/${step.nodeId}): коммит не взял лок — добьёт крон`);
    }
  }

  /** Собрать контекст (+join/cluster) и выполнить ноду. Без предположений о локе. */
  private async runProvider(instance: InstanceLite, plan: CompiledPlan, step: StepLite, node: CompiledPlan['nodes'][string]): Promise<NodeRunResult> {
    const provider = this.registry.get(node.type);
    if (!provider) throw new Error(`Неизвестная нода «${step.nodeId}»`);
    const ctx = await this.buildContext(instance, step, node);
    if (node.join) ctx.join = { arrivals: step.joinArrivals ?? 0, expected: plan.joinExpected[step.nodeId] ?? 1 };
    if (node.cluster) ctx.cluster = await this.buildAgentCluster(instance, plan, step.nodeId, 0);
    return provider.run(ctx);
  }

  /**
   * Ф2: выполнить ноду с политикой ошибок. Retry On Fail (n8n#3) — только вне лока
   * (allowRetry): повторяет и throw, и «обработанный» сбой (вернувшийся порт 'error') до
   * maxTries с паузой. Исчерпав повторы на throw — применяет onError (n8n#4/sfflow#3):
   * errorOutput→порт «error», continue→main/success, stop→валить инстанс.
   */
  private async runNodeWithPolicy(
    instance: InstanceLite,
    plan: CompiledPlan,
    step: StepLite,
    node: CompiledPlan['nodes'][string],
    allowRetry: boolean,
  ): Promise<{ result: NodeRunResult } | { fail: string }> {
    const maxTries = 1 + (allowRetry ? node.retryMaxTries : 0);
    const waitMs = node.retryWaitMs;
    let lastErr: unknown;
    let retries = 0;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const result = await this.runProvider(instance, plan, step, node);
        // «Обработанный» сбой (нода сама вернула порт 'error') — повторяем, если есть попытки.
        if (allowRetry && result.kind === 'complete' && result.outputKey === 'error' && attempt < maxTries) {
          retries++;
          if (waitMs > 0) await this.sleep(waitMs);
          continue;
        }
        return { result: this.withRetryMeta(result, retries) };
      } catch (err) {
        lastErr = err;
        if (attempt < maxTries) {
          retries++;
          if (waitMs > 0) await this.sleep(waitMs);
          continue;
        }
      }
    }
    // Throw после всех попыток → решает onError.
    const message = lastErr instanceof Error ? lastErr.message : 'Ошибка выполнения ноды';
    const recovered = this.applyOnError(node, message);
    return recovered ? { result: this.withRetryMeta(recovered, retries) } : { fail: `${node.label}: ${message}` };
  }

  /** Пометить результат числом выполненных повторов (для наблюдаемости в output._retries). */
  private withRetryMeta(result: NodeRunResult, retries: number): NodeRunResult {
    if (retries <= 0 || result.kind !== 'complete') return result;
    return { ...result, output: { ...(result.output ?? {}), _retries: retries } };
  }

  /** onError-маршрутизация упавшей (throw) ноды: errorOutput→порт «error»; continue→main/success; иначе стоп (null). */
  private applyOnError(node: CompiledPlan['nodes'][string], message: string): NodeRunResult | null {
    if (node.onError === 'stop') return null;
    const mainOuts = (this.registry.get(node.type)?.descriptor.outputs ?? []).filter((o) => (o.type ?? 'main') === 'main');
    if (node.onError === 'errorOutput' && mainOuts.some((o) => o.key === 'error')) {
      return { kind: 'complete', outputKey: 'error', output: { error: message } };
    }
    // continue (или errorOutput без порта «error») → продолжаем по main/success.
    const cont = mainOuts.find((o) => o.key === 'main' || o.key === 'success');
    return cont ? { kind: 'complete', outputKey: cont.key, output: { error: message, continued: true } } : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.min(Math.max(0, ms), 10_000)));
  }

  /** Применить результат ноды. ПРЕДПОЛАГАЕТ удерживаемый инстанс-лок (bookkeeping сериализован). */
  private async commitResult(instance: InstanceLite, plan: CompiledPlan, step: StepLite, result: NodeRunResult): Promise<void> {
    if (result.kind === 'wait') {
      await this.commitWait(instance, step, result);
      return;
    }
    await this.completeStepAndAdvance(instance.id, plan, step.id, step.nodeId, result.outputKey ?? 'main', result.output, undefined, result.setVariables);
  }

  /** Ожидание: шаг «засыпает» строкой БД (activated=true, аренда снята — хук/крон разбудят). */
  private async commitWait(instance: InstanceLite, step: StepLite, result: Extract<NodeRunResult, { kind: 'wait' }>): Promise<void> {
    const patch = result.patch ?? {};
    try {
      const patched = await this.db.processStepRun.updateMany({
        where: { id: step.id, status: 'active' },
        data: {
          activated: true, // side-effect отработал — kick больше не трогает шаг
          leasedUntil: null, // аренда снята: шаг легитимно ждёт (двигают хук/крон)
          taskId: patch.taskId,
          assigneeId: patch.assigneeId,
          departmentId: patch.departmentId,
          deadlineAt: patch.deadlineAt,
          output: (result.output ?? undefined) as object | undefined,
        },
      });
      if (patched.count === 0 && patch.taskId) {
        // Инстанс отменили/завершили, пока создавалась задача — гасим сироту.
        await this.tasks.updateTask(instance.startedById, patch.taskId, { status: 'cancelled' }).catch(() => undefined);
      }
    } catch (patchErr) {
      if (patch.taskId) {
        await this.tasks.updateTask(instance.startedById, patch.taskId, { status: 'cancelled' }).catch(() => undefined);
      }
      throw patchErr;
    }
  }

  /** Все токены погашены (branch-local end / слияния) → инстанс завершён. Status-guard от гонок. */
  private async completeInstanceIfDrained(instanceId: string): Promise<void> {
    const done = await this.db.processInstance.updateMany({
      where: { id: instanceId, status: 'running' },
      data: { status: 'done', finishedAt: new Date() },
    });
    if (done.count > 0) await this.afterFinished(instanceId);
  }

  /**
   * Выполнить bookkeeping-критическую секцию под инстанс-локом с РЕТРАЕМ захвата
   * (в отличие от kickOnce, который бесхитростно уходит): внешний сигнал (приёмка задачи,
   * решение, таймер, коммит I/O) обязан приземлиться, а не потеряться (A7/P3).
   */
  private async withInstanceLock(instanceId: string, fn: () => Promise<void>): Promise<boolean> {
    const key = this.kickKey(instanceId);
    let token: string | null = null;
    for (let i = 0; i < 12 && !token; i++) {
      token = await this.redis.acquireLock(key, ProcessEngineService.KICK_LOCK_TTL_MS);
      if (!token) await new Promise((r) => setTimeout(r, 120));
    }
    if (!token) return false; // ~1.4с не смогли — крон-сверка добьёт
    try {
      await fn();
      return true;
    } finally {
      await this.redis.releaseLock(key, token);
    }
  }

  /**
   * Завершить шаг и продвинуть токен — атомарно, со status-guard'ом (двойное
   * продвижение проигрывает на updateMany.count === 0, как в кошельке).
   */
  private async completeStepAndAdvance(
    instanceId: string,
    plan: CompiledPlan,
    stepId: string,
    nodeId: string,
    outputKey: string,
    output?: Record<string, unknown>,
    extra?: { decision?: string },
    setVariables?: Record<string, unknown>,
  ): Promise<AdvanceOutcome> {
    const node = plan.nodes[nodeId];
    const result = await this.db.$transaction(async (tx): Promise<AdvanceOutcome> => {
      // Инстанс — ПЕРВЫЙ замок ВСЕХ писателей (advance/cancel/fail берут его в одном
      // порядке): нет ни «осиротевшего active-шага в отменённом инстансе», ни дедлока.
      const alive = await tx.processInstance.updateMany({
        where: { id: instanceId, status: 'running' },
        data: { status: 'running' },
      });
      if (alive.count === 0) return 'noop';

      const claimed = await tx.processStepRun.updateMany({
        where: { id: stepId, status: 'active' },
        data: {
          status: 'done',
          outcome: outputKey,
          output: (output ?? undefined) as object | undefined,
          decision: extra?.decision,
          leasedUntil: null, // шаг завершён — аренда снята
          completedAt: new Date(),
        },
      });
      if (claimed.count === 0) return 'noop';

      // Ф5: поток данных — мержим setVariables (нода «Задать данные» / индекс+элемент цикла)
      // в анкету инстанса (read-merge-write в этой же транзакции). Параллельные ветки, пишущие
      // переменные одновременно, — last-write-wins (для последовательного цикла/Set неактуально).
      if (setVariables && Object.keys(setVariables).length > 0) {
        const cur = await tx.processInstance.findUnique({ where: { id: instanceId }, select: { variables: true } });
        await tx.processInstance.update({
          where: { id: instanceId },
          data: { variables: { ...((cur?.variables as Record<string, unknown>) ?? {}), ...setVariables } as object },
        });
      }

      if (node?.terminal) {
        // A2 (branch-local end): «Конец» гасит ТОЛЬКО свой токен (шаг уже done выше).
        // Инстанс НЕ завершаем и соседние ветки НЕ отменяем — они доживут сами; финал
        // наступит, когда все токены сольются/дойдут (completeInstanceIfDrained → done).
        return 'consumed';
      }

      const nextIds = plan.adjacency[nodeId]?.[outputKey] ?? [];
      if (nextIds.length === 0 || nextIds.some((id) => !plan.nodes[id])) {
        await this.markErrorTx(tx, instanceId, null, `Выход «${outputKey}» ноды «${node?.label ?? nodeId}» никуда не ведёт`);
        return 'failed';
      }

      // P8/A5: монотонный счётчик спавнов (O(1) атомарный инкремент вместо COUNT(*)
      // всех шагов на каждом переходе — было O(M²)). Считает фан-ауты токена = верная
      // метрика бесконечного цикла; done/cancelled в знаменатель больше НЕ попадают.
      const bumped = await tx.processInstance.update({
        where: { id: instanceId },
        data: { stepsSpawned: { increment: nextIds.length } },
        select: { stepsSpawned: true },
      });
      if (bumped.stepsSpawned > PROCESS_LIMITS.maxStepsPerInstance) {
        await this.markErrorTx(tx, instanceId, null, 'Превышен лимит шагов процесса (возможен бесконечный цикл)');
        return 'failed';
      }

      // Спавним токен на каждый целевой узел (Развилка = несколько; обычно один).
      for (const nextId of nextIds) {
        const nextNode = plan.nodes[nextId];
        if (nextNode.join) {
          // Слияние (A3): депонируем токен в общий join-шаг (создаём при первом приходе),
          // будим его (activated=false → kick запустит join.run, проверит число прибытий).
          // Все депозиты инстанса сериализованы инстанс-локом (A7) → гонки create-create нет;
          // partial-unique (node_type=parallel.join, active) — фейл-сейф от edge с истёкшим локом.
          const inc = await tx.processStepRun.updateMany({
            where: { instanceId, nodeId: nextId, status: 'active' },
            data: { joinArrivals: { increment: 1 }, activated: false },
          });
          if (inc.count === 0) {
            await tx.processStepRun.create({
              data: { instanceId, nodeId: nextId, nodeType: nextNode.type, label: nextNode.label, status: 'active', sourceStepId: stepId, joinArrivals: 1 },
            });
          }
        } else {
          await tx.processStepRun.create({
            data: { instanceId, nodeId: nextId, nodeType: nextNode.type, label: nextNode.label, status: 'active', sourceStepId: stepId },
          });
        }
      }
      return 'advanced';
    });

    if (result === 'failed') await this.afterFailed(instanceId);
    return result;
  }

  // ---------------------------------------------------------------
  // Внешние события (хук Задачника + подстраховка шиной)
  // ---------------------------------------------------------------

  /** Задача процесса полностью принята → шаг done, токен едет дальше. Идемпотентно.
   *  Advance-фаза под инстанс-локом (A7): депозит в join сериализован против kick/крон. */
  async onTaskCompleted(taskId: string): Promise<void> {
    const step0 = await this.db.processStepRun.findFirst({ where: { taskId, status: 'active' }, select: { instanceId: true } });
    if (!step0) return;
    const advanced = await this.withInstanceLock(step0.instanceId, async () => {
      const step = await this.db.processStepRun.findFirst({ where: { taskId, status: 'active' } });
      if (!step) return;
      const instance = await this.db.processInstance.findUnique({ where: { id: step.instanceId } });
      if (!instance || instance.status !== 'running') return;
      const plan = await this.getPlan(instance.versionId);
      if (!plan) return;
      await this.completeStepAndAdvance(instance.id, plan, step.id, step.nodeId, 'main', { taskId });
    });
    if (advanced) await this.kick(step0.instanceId);
  }

  /** Связанную задачу удалили — процесс не может продолжаться. */
  async onTaskDeleted(taskId: string): Promise<void> {
    const step = await this.db.processStepRun.findFirst({ where: { taskId, status: 'active' } });
    if (!step) return;
    await this.failInstance(step.instanceId, step.id, 'Связанная задача удалена');
  }

  /** Задачу-шаг отменили в Задачнике — работа не будет сделана, процесс останавливается. */
  async onTaskCancelled(taskId: string): Promise<void> {
    const step = await this.db.processStepRun.findFirst({ where: { taskId, status: 'active' } });
    if (!step) return;
    await this.failInstance(step.instanceId, step.id, 'Задача шага отменена — процесс остановлен');
  }

  // ---------------------------------------------------------------
  // Ф2: claim очереди отдела · решение по одобрению · таймеры/эскалация
  // ---------------------------------------------------------------

  /**
   * Забрать задачу отдела из очереди: создаёт реальную задачу исполнителю-claimer'у
   * (Постановщик — инициатор процесса). Конкурентный claim проигрывает на status-guard'е,
   * проигравший гасит свою задачу (как orphan-компенсация wait-шага).
   */
  async claimQueueStep(userId: string, instanceId: string, stepId: string): Promise<string> {
    const step = await this.db.processStepRun.findFirst({
      where: { id: stepId, instanceId, status: 'active', taskId: null, departmentId: { not: null } },
    });
    if (!step) throw new BadRequestException('Задача уже забрана или недоступна');
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId } });
    if (!instance || instance.status !== 'running') throw new BadRequestException('Процесс не активен');

    const isMember = await this.db.relationTuple.count({
      where: { resourceType: 'department', resourceId: step.departmentId!, relation: 'member', subjectType: 'user', subjectId: userId },
    });
    if (isMember === 0) throw new ForbiddenException('Задача доступна только сотрудникам этого отдела');

    const spec = (step.output ?? {}) as { title?: string; description?: string | null; dueInHours?: number | null };
    const task = await this.tasks.createTask(
      instance.startedById,
      {
        title: spec.title || 'Задача процесса',
        description: spec.description ?? undefined,
        executorId: userId,
        dueDate: spec.dueInHours ? new Date(Date.now() + spec.dueInHours * 3_600_000).toISOString() : undefined,
        workspaceId: instance.workspaceId,
      } as Parameters<TasksService['createTask']>[1],
      { skipEnvironmentChecks: true, origin: 'process' }, // A4: не самозапускать процессы
    );
    // Захват: первый выигрывает; остальные → 0 строк → гасим свою лишнюю задачу.
    const claimed = await this.db.processStepRun.updateMany({
      where: { id: stepId, status: 'active', taskId: null },
      data: { taskId: task.id, assigneeId: userId, claimedById: userId, claimedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.tasks.updateTask(instance.startedById, task.id, { status: 'cancelled' }).catch(() => undefined);
      throw new BadRequestException('Задачу только что забрал другой сотрудник');
    }
    return task.id;
  }

  /** Решение по одобрению: токен идёт по ветке approved/rejected (отклонение можно вернуть назад). */
  async decideApproval(userId: string, instanceId: string, stepId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const step = await this.db.processStepRun.findFirst({
      where: { id: stepId, instanceId, status: 'active', nodeType: 'human.approval', decision: null },
    });
    if (!step) throw new BadRequestException('Решение уже вынесено или шаг недоступен');
    if (step.assigneeId !== userId) throw new ForbiddenException('Решение выносит назначенный согласующий');
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId } });
    if (!instance || instance.status !== 'running') throw new BadRequestException('Процесс не активен');
    const plan = await this.getPlan(instance.versionId);
    if (!plan) throw new BadRequestException('План версии не найден');
    // Advance-фаза под инстанс-локом (A7). Перепроверяем шаг под локом (могли решить/отменить).
    const advanced = await this.withInstanceLock(instanceId, async () => {
      const fresh = await this.db.processStepRun.findFirst({
        where: { id: stepId, status: 'active', nodeType: 'human.approval', decision: null },
      });
      if (!fresh) return;
      await this.completeStepAndAdvance(instance.id, plan, fresh.id, fresh.nodeId, decision, { decision }, { decision });
    });
    if (advanced) await this.kick(instanceId);
  }

  /** Ф2.5: переназначить исполнителя активного шага-задачи на другого сотрудника. */
  async reassignStep(instanceId: string, stepId: string, newUserId: string): Promise<void> {
    const step = await this.db.processStepRun.findFirst({
      where: { id: stepId, instanceId, status: 'active', taskId: { not: null } },
    });
    if (!step) throw new BadRequestException('Шаг недоступен для переназначения (нужна активная задача)');
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId } });
    if (!instance || instance.status !== 'running') throw new BadRequestException('Процесс не активен');
    const isMember = await this.db.userRole.count({
      where: { userId: newUserId, context: 'workspace', tenantId: instance.workspaceId, isActive: true, role: { not: 'contractor' } },
    });
    if (isMember === 0) throw new BadRequestException('Новый исполнитель не работает в организации');
    await this.tasks.reassignExecutorTrusted(step.taskId!, newUserId);
    await this.db.processStepRun.update({ where: { id: stepId }, data: { assigneeId: newUserId } });
  }

  /**
   * Кроновый проход: добивает истёкшие ПАУЗЫ (token едет дальше) и шлёт ЭСКАЛАЦИЮ по
   * просроченным человеческим шагам (инициатору, один раз). Скан по индексу deadlineAt.
   */
  async runDueTimersAndEscalations(): Promise<void> {
    const now = new Date();
    // 1) Паузы, чьё время вышло.
    const dueDelays = await this.db.processStepRun.findMany({
      where: { status: 'active', nodeType: 'delay', deadlineAt: { lte: now }, instance: { status: 'running' } },
      select: { id: true, nodeId: true, instanceId: true },
      take: 200,
    });
    for (const s of dueDelays) {
      try {
        const instance = await this.db.processInstance.findUnique({ where: { id: s.instanceId } });
        if (!instance || instance.status !== 'running') continue;
        const plan = await this.getPlan(instance.versionId);
        if (!plan) continue;
        // Advance-фаза под инстанс-локом (A7); перепроверяем шаг под локом.
        const advanced = await this.withInstanceLock(s.instanceId, async () => {
          const fresh = await this.db.processStepRun.findFirst({ where: { id: s.id, status: 'active' } });
          if (!fresh) return;
          await this.completeStepAndAdvance(instance.id, plan, s.id, s.nodeId, 'main', { kind: 'delay' });
        });
        if (advanced) await this.kick(instance.id);
      } catch (err) {
        this.logger.error(`delay timer (${s.id}): ${(err as Error).message}`);
      }
    }

    // 2) Просроченные человеческие шаги → эскалация инициатору (дедуп через escalatedAt).
    const overdue = await this.db.processStepRun.findMany({
      where: {
        status: 'active',
        nodeType: { in: ['human.task', 'human.approval'] },
        deadlineAt: { lte: now },
        escalatedAt: null,
        instance: { status: 'running' },
      },
      select: {
        id: true,
        nodeId: true,
        assigneeId: true,
        instance: { select: { id: true, versionId: true, startedById: true, workspaceId: true, definition: { select: { name: true } } } },
      },
      take: 200,
    });
    for (const s of overdue) {
      const claimed = await this.db.processStepRun.updateMany({
        where: { id: s.id, escalatedAt: null },
        data: { escalatedAt: now },
      });
      if (claimed.count === 0) continue; // другой инстанс крона уже эскалировал
      const plan = await this.getPlan(s.instance.versionId);
      const label = plan?.nodes[s.nodeId]?.label ?? s.nodeId;
      const recipients = new Set<string>([s.instance.startedById]);
      if (s.assigneeId) recipients.add(s.assigneeId);
      for (const uid of recipients) {
        await this.notifications
          .notify(uid, 'process.step.overdue', { title: label, processName: s.instance.definition.name }, {
            actionUrl: `/workspaces/${s.instance.workspaceId}/processes/instances/${s.instance.id}`,
          })
          .catch(() => undefined);
      }
    }
  }

  /**
   * A1+A8: добить зависшие СЛИЯНИЯ. Статичный in-degree ждёт N токенов, но ветку мог увести
   * «Если»(false) или свой «Конец» — тогда arrivals < expected навсегда, инстанс висит без
   * сигнала. Крон-проход: если ни один живой токен уже НЕ может дойти до join (reachability
   * по плану), срабатываем с тем, что пришло; если arrivals дозрели, но kick был пропущен —
   * тоже добиваем. Так вечное зависание превращается в нормальное продолжение, а не в error.
   */
  async sweepStuckJoins(): Promise<void> {
    const joins = await this.db.processStepRun.findMany({
      where: { status: 'active', nodeType: 'parallel.join', instance: { status: 'running' } },
      select: { id: true, instanceId: true },
      take: 200,
    });
    for (const j of joins) {
      let fired = false;
      try {
        await this.withInstanceLock(j.instanceId, async () => {
          const instance = await this.db.processInstance.findUnique({ where: { id: j.instanceId } });
          if (!instance || instance.status !== 'running') return;
          const plan = await this.getPlan(instance.versionId);
          if (!plan) return;
          const step = await this.db.processStepRun.findUnique({ where: { id: j.id } });
          if (!step || step.status !== 'active') return;
          const expected = plan.joinExpected[step.nodeId] ?? 1;
          const others = await this.db.processStepRun.findMany({
            where: { instanceId: instance.id, status: 'active', id: { not: step.id } },
            select: { nodeId: true },
          });
          const someoneCanArrive = others.some((o) => this.canReach(plan, o.nodeId, step.nodeId));
          // Дозрело (пропущенный kick) ИЛИ никто уже не дойдёт (уведённая ветка) → продолжаем.
          if (step.joinArrivals >= expected || !someoneCanArrive) {
            await this.completeStepAndAdvance(instance.id, plan, step.id, step.nodeId, 'main', {
              arrivals: step.joinArrivals,
              forced: step.joinArrivals < expected,
            });
            fired = true;
          }
        });
        if (fired) await this.kick(j.instanceId);
      } catch (err) {
        this.logger.error(`sweepStuckJoins(${j.id}): ${(err as Error).message}`);
      }
    }
  }

  /**
   * A1 (eager, под инстанс-локом): если активное СЛИЯНИЕ уже дозрело (пропущенный kick) или
   * до него не дойдёт ни один живой токен (ветку увёл condition/свой «Конец») — добить его
   * с тем, что пришло. Возвращает true, если сработало (звать цикл дальше). Синхронный аналог
   * cron-sweepStuckJoins (та же логика; крон — подстраховка для multi-instance/пропущенных).
   */
  private async tryForceFireStuckJoin(
    instanceId: string,
    plan: CompiledPlan,
    activeSteps: { id: string; nodeId: string; joinArrivals: number }[],
  ): Promise<boolean> {
    for (const s of activeSteps) {
      if (!plan.nodes[s.nodeId]?.join) continue;
      const expected = plan.joinExpected[s.nodeId] ?? 1;
      const someoneCanArrive = activeSteps.some((o) => o.id !== s.id && this.canReach(plan, o.nodeId, s.nodeId));
      if (s.joinArrivals >= expected || !someoneCanArrive) {
        const outcome = await this.completeStepAndAdvance(instanceId, plan, s.id, s.nodeId, 'main', {
          arrivals: s.joinArrivals,
          forced: s.joinArrivals < expected,
        });
        if (outcome === 'advanced' || outcome === 'consumed') return true;
      }
    }
    return false;
  }

  /** Достижим ли target из from по adjacency плана (BFS) — «может ли живой токен дойти до слияния». */
  private canReach(plan: CompiledPlan, from: string, target: string): boolean {
    if (from === target) return true;
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const targets of Object.values(plan.adjacency[cur] ?? {})) {
        for (const n of targets) {
          if (n === target) return true;
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Отмена / ошибка
  // ---------------------------------------------------------------

  async cancelInstance(instanceId: string, byUserId: string): Promise<boolean> {
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId } });
    if (!instance) return false;

    // Шаги к отмене выбираем ВНУТРИ транзакции после захвата инстанса — снимок «до»
    // мог бы отменить уже принятую задачу (шаг успел завершиться между снимком и claim).
    const taskIds = await this.db.$transaction(async (tx) => {
      const claimed = await tx.processInstance.updateMany({
        where: { id: instanceId, status: 'running' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      if (claimed.count === 0) return null;
      const taskSteps = await tx.processStepRun.findMany({
        where: { instanceId, status: 'active', taskId: { not: null } },
        select: { taskId: true },
      });
      await tx.processStepRun.updateMany({
        where: { instanceId, status: 'active' },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      return taskSteps.map((s) => s.taskId).filter((x): x is string => !!x);
    });
    if (taskIds === null) return false;

    // Открытые задачи процесса отменяем от имени их Постановщика (инициатора).
    for (const taskId of taskIds) {
      if (!taskId) continue;
      try {
        await this.tasks.updateTask(instance.startedById, taskId, { status: 'cancelled' });
      } catch {
        // задача уже закрыта/удалена — не мешаем отмене процесса
      }
    }
    this.events.emit(
      'process.cancelled',
      { instanceId, definitionId: instance.definitionId, workspaceId: instance.workspaceId, byUserId },
      'processes',
    );
    return true;
  }

  async failInstance(instanceId: string, stepId: string | null, message: string): Promise<void> {
    const failed = await this.db.$transaction(async (tx) => {
      const claimed = await this.markErrorTx(tx, instanceId, stepId, message);
      return claimed;
    });
    if (failed) await this.afterFailed(instanceId);
  }

  /** Перевод в error внутри уже открытой транзакции (без after-эффектов). */
  private async markErrorTx(
    tx: Pick<DatabaseService, 'processInstance' | 'processStepRun'>,
    instanceId: string,
    stepId: string | null,
    message: string,
  ): Promise<boolean> {
    const claimed = await tx.processInstance.updateMany({
      where: { id: instanceId, status: 'running' },
      data: { status: 'error', error: message, finishedAt: new Date() },
    });
    if (claimed.count === 0) return false;
    if (stepId) {
      await tx.processStepRun.updateMany({
        where: { id: stepId, status: 'active' },
        data: { status: 'error', error: message, completedAt: new Date() },
      });
    }
    await tx.processStepRun.updateMany({
      where: { instanceId, status: 'active' },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    return true;
  }

  // ---------------------------------------------------------------
  // After-эффекты (уведомления/события — вне транзакций)
  // ---------------------------------------------------------------

  private async afterFinished(instanceId: string): Promise<void> {
    const instance = await this.db.processInstance.findUnique({
      where: { id: instanceId },
      include: { definition: { select: { name: true } } },
    });
    if (!instance) return;
    await this.notifications
      .notify(
        instance.startedById,
        'process.finished',
        { processName: instance.definition.name },
        { actionUrl: `/workspaces/${instance.workspaceId}/processes/instances/${instanceId}` },
      )
      .catch(() => undefined);
    this.events.emit(
      'process.finished',
      { instanceId, definitionId: instance.definitionId, workspaceId: instance.workspaceId, startedById: instance.startedById },
      'processes',
    );
  }

  private async afterFailed(instanceId: string): Promise<void> {
    const instance = await this.db.processInstance.findUnique({
      where: { id: instanceId },
      include: { definition: { select: { name: true, createdById: true } } },
    });
    if (!instance) return;
    // sfflow#4: сбой видит и ОТВЕТСТВЕННЫЙ за процесс (создатель определения), а не только
    // инициатор — для авто-запусков (runAs=служебный сотрудник) инициатор мог бы не заметить.
    const recipients = new Set<string>([instance.startedById, instance.definition.createdById]);
    for (const uid of recipients) {
      await this.notifications
        .notify(
          uid,
          'process.failed',
          { processName: instance.definition.name, error: instance.error ?? '' },
          { actionUrl: `/workspaces/${instance.workspaceId}/processes/instances/${instanceId}` },
        )
        .catch(() => undefined);
    }
    this.events.emit(
      'process.failed',
      { instanceId, definitionId: instance.definitionId, workspaceId: instance.workspaceId, startedById: instance.startedById, error: instance.error },
      'processes',
    );
  }

  // ---------------------------------------------------------------
  // Контекст и план
  // ---------------------------------------------------------------

  async getPlan(versionId: string): Promise<CompiledPlan | null> {
    const cached = this.planCache.get(versionId);
    if (cached) {
      // P10: LRU — освежаем позицию (delete+set двигает ключ в конец Map = «недавно использован»).
      this.planCache.delete(versionId);
      this.planCache.set(versionId, cached);
      return cached;
    }
    const version = await this.db.processVersion.findUnique({ where: { id: versionId } });
    const plan = (version?.compiled as CompiledPlan | null) ?? null;
    if (plan) this.cachePlan(versionId, plan);
    return plan;
  }

  /** LRU-кэш планов с потолком (версии копятся вечно — publish создаёт новую каждый раз;
   *  вытесняем НАИМЕНЕЕ недавно использованный — первый ключ Map). */
  private cachePlan(versionId: string, plan: CompiledPlan): void {
    this.planCache.delete(versionId);
    if (this.planCache.size >= 100) {
      const oldest = this.planCache.keys().next().value;
      if (oldest) this.planCache.delete(oldest);
    }
    this.planCache.set(versionId, plan);
  }

  isAutoType(nodeType: string): boolean {
    return this.registry.get(nodeType)?.descriptor.auto ?? true;
  }

  /**
   * Ф4.5: собрать кластер агента — резолвнуть подключённые Модель/Память/Инструменты
   * (под-ноды через типизированные порты). Под-агент (через astool) подключается
   * инструментом рекурсивно (с лимитом глубины).
   */
  private async buildAgentCluster(
    instance: { id: string; workspaceId: string; startedById: string; variables: unknown; definitionId: string },
    plan: CompiledPlan,
    agentNodeId: string,
    depth: number,
  ): Promise<AgentCluster> {
    if (depth > 3) throw new Error('Слишком глубокая вложенность агентов');
    const att = plan.attachments[agentNodeId] ?? {};
    const modelId = att.ai_model?.[0];
    if (!modelId || !plan.nodes[modelId]) throw new Error('К агенту не подключена Модель');

    const modelNode = plan.nodes[modelId];
    const modelCtx = await this.buildContext(instance, { id: '', nodeId: modelId }, modelNode);
    const model = await resolveLlmConfig(modelCtx, modelNode.config as Parameters<typeof resolveLlmConfig>[1]);

    // Память (Redis по ключу сессии).
    let memory: AgentCluster['memory'];
    const memId = att.ai_memory?.[0];
    if (memId && plan.nodes[memId]) {
      const memNode = plan.nodes[memId];
      const memCtx = await this.buildContext(instance, { id: '', nodeId: memId }, memNode);
      const sessionKey = memCtx.render(String(memNode.config.sessionKey ?? '')).trim() || instance.id;
      const window = Math.min(50, Math.max(1, Number(memNode.config.window ?? 10)));
      const key = `proc:agentmem:${instance.workspaceId}:${sessionKey}`;
      // P12: Redis LIST (rpush/lrange/ltrim), НЕ read-modify-write JSON — параллельные
      // append'ы разных агентов на один ключ не теряют реплики (было: гонка перезаписи).
      const client = this.redis.getClient();
      memory = {
        load: async () => {
          const raw = await client.lrange(key, -window, -1);
          return raw
            .map((s) => { try { return JSON.parse(s) as { u: string; a: string }; } catch { return null; } })
            .filter((t): t is { u: string; a: string } => !!t)
            .map((t) => `Пользователь: ${t.u}\nАгент: ${t.a}`)
            .join('\n\n');
        },
        append: async (u, a) => {
          await client.rpush(key, JSON.stringify({ u: u.slice(0, 2000), a: a.slice(0, 2000) }));
          await client.ltrim(key, -window, -1);
          await client.expire(key, 7 * 24 * 3600);
        },
      };
    }

    // Инструменты: под-ноды-инструменты + под-агенты (рекурсивно).
    const tools: AgentTool[] = [];
    for (const toolId of att.ai_tool ?? []) {
      const toolNode = plan.nodes[toolId];
      if (!toolNode) continue;
      const provider = this.registry.get(toolNode.type);
      const spec = provider?.descriptor.tool;
      if (spec) {
        const toolCtx = await this.buildContext(instance, { id: '', nodeId: toolId }, toolNode);
        tools.push({ name: spec.name, description: spec.description, schema: spec.schema, run: (input) => spec.execute(toolCtx, input) });
      } else if (toolNode.cluster) {
        // под-агент как инструмент (оркестратор → специалист)
        const subCluster = await this.buildAgentCluster(instance, plan, toolId, depth + 1);
        const subCtx = await this.buildContext(instance, { id: '', nodeId: toolId }, toolNode);
        subCluster.systemPrompt = toolNode.config.systemPrompt ? subCtx.render(String(toolNode.config.systemPrompt)) : undefined;
        const name = (toolNode.label || `agent`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || `agent_${toolId.slice(0, 6)}`;
        const maxIter = Math.min(8, Math.max(1, Number(toolNode.config.maxIterations ?? 5)));
        tools.push({
          name,
          description: String(toolNode.config.toolDescription || `Делегировать задачу агенту «${toolNode.label}»`),
          schema: { type: 'object', properties: { input: { type: 'string', description: 'Задача/вопрос агенту' } }, required: ['input'] },
          run: async (input) => (await runAgentWithCluster(subCluster, String(input.input ?? ''), maxIter)).text,
        });
      }
    }

    // Парсер структурированного ответа (под-нода «Структурированный ответ»).
    let outputParser: AgentCluster['outputParser'];
    const parserId = att.ai_output?.[0];
    if (parserId && plan.nodes[parserId]) {
      outputParser = { instruction: parserInstruction(String(plan.nodes[parserId].config.fields ?? '')) };
    }

    return { model, memory, tools, outputParser };
  }

  /** Стабильные имена инициатора/процесса (кэш на инстанс) — P1: не по 2 запроса на ноду. */
  private async getInstanceMeta(instance: { id: string; startedById: string; definitionId: string }): Promise<{ initiatorName: string; definitionName: string }> {
    const cached = this.instanceMetaCache.get(instance.id);
    if (cached) return cached;
    const [starter, definition] = await Promise.all([
      this.db.user.findUnique({ where: { id: instance.startedById }, select: { firstName: true, lastName: true } }),
      this.db.processDefinition.findUnique({ where: { id: instance.definitionId }, select: { name: true } }),
    ]);
    const meta = {
      initiatorName: [starter?.firstName, starter?.lastName].filter(Boolean).join(' '),
      definitionName: definition?.name ?? 'Процесс',
    };
    if (this.instanceMetaCache.size >= 200) {
      const oldest = this.instanceMetaCache.keys().next().value;
      if (oldest) this.instanceMetaCache.delete(oldest);
    }
    this.instanceMetaCache.set(instance.id, meta);
    return meta;
  }

  private async buildContext(
    instance: { id: string; workspaceId: string; startedById: string; variables: unknown; definitionId: string },
    step: { id: string; nodeId: string },
    node: { label: string; config: Record<string, unknown> },
  ): Promise<NodeRunContext> {
    const meta = await this.getInstanceMeta(instance);
    const variables = (instance.variables ?? {}) as Record<string, unknown>;
    // Результаты завершённых шагов ({{steps.<nodeId>...}}) грузим ТОЛЬКО если конфиг ноды
    // реально на них ссылается (P1): у большинства нод ссылок нет → 0 запросов вместо O(N²).
    const steps: Record<string, unknown> = {};
    if (/\{\{\s*steps\b/.test(JSON.stringify(node.config ?? {}))) {
      const doneSteps = await this.db.processStepRun.findMany({
        where: { instanceId: instance.id, status: 'done' },
        select: { nodeId: true, output: true },
        orderBy: { completedAt: 'asc' },
      });
      for (const s of doneSteps) if (s.output !== null) steps[s.nodeId] = s.output; // последний завершённый выигрывает
    }
    const renderCtx: Record<string, unknown> = {
      form: variables,
      steps,
      initiator: { name: meta.initiatorName },
      instance: { name: meta.definitionName },
      // Ф5: текущий элемент цикла (нода «Перебрать список» пишет его в variables._item).
      item: (variables as Record<string, unknown>)._item ?? null,
    };
    return {
      instanceId: instance.id,
      workspaceId: instance.workspaceId,
      startedById: instance.startedById,
      definitionName: meta.definitionName,
      variables,
      step: { id: step.id, nodeId: step.nodeId, label: node.label },
      config: node.config,
      render: (text: string) => renderTemplate(text, renderCtx),
      resolveValue: (expr: string) => resolveExpr(renderCtx, expr),
      deps: {
        tasks: this.tasks,
        notifications: this.notifications,
        db: this.db,
        // Ленивый резолвер (ModuleRef, strict:false) — ищет провайдер во всём графе
        // приложения; вызывается ТОЛЬКО нодой, которой сервис нужен (без eager-инъекции).
        getService: <T = unknown>(token: string | symbol | (new (...args: unknown[]) => unknown)): T =>
          this.moduleRef.get<T>(token as never, { strict: false }),
      },
    };
  }
}

/** Плоский путь `a.b.c` в значение по own-property (без eval) — быстрый путь подстановок. */
function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    // own-property only: {{form.constructor}} не должен доставать прототипные функции
    return Object.prototype.hasOwnProperty.call(acc, key) ? (acc as Record<string, unknown>)[key] : undefined;
  }, ctx);
}

/**
 * Ф5: разрешить содержимое `{{...}}` (или голый путь/выражение) в СЫРОЕ значение.
 * Плоский путь (`a.b.c`) — быстрый path-lookup (точное старое поведение, ноль риска для
 * существующих шаблонов). Всё остальное (арифметика/сравнения) — безопасный вычислитель.
 */
function resolveExpr(ctx: Record<string, unknown>, raw: string): unknown {
  const expr = raw.replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
  if (!expr) return undefined;
  if (/^[\w.-]+$/.test(expr)) return resolvePath(ctx, expr);
  try {
    return evalExpression(expr, ctx);
  } catch {
    return undefined;
  }
}

/** Подстановки `{{form.budget}}` / `{{ item.sum * 1.12 }}` → текст (объект/массив → JSON). */
function renderTemplate(text: string, ctx: Record<string, unknown>): string {
  return text.replace(/\{\{([^}]*)\}\}/g, (_m, inner: string) => {
    const value = resolveExpr(ctx, inner);
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'да' : 'нет';
    // Объект/массив (напр. {{steps.fetch.body}}) — сериализуем в JSON, чтобы AI-промпт
    // мог сослаться на целый результат прошлого шага.
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value).slice(0, 8000);
      } catch {
        return '';
      }
    }
    return String(value);
  });
}
