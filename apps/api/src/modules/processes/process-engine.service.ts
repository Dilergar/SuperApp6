import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PROCESS_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';
import { ProcessNodeRegistry } from './process-node.registry';
import { parserInstruction, resolveLlmConfig, runAgentWithCluster } from './process-ai-nodes';
import type { AgentCluster, AgentTool, CompiledPlan, NodeRunContext } from './process-node.types';

type AdvanceOutcome = 'advanced' | 'finished' | 'failed' | 'noop';

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

  constructor(
    private db: DatabaseService,
    private registry: ProcessNodeRegistry,
    private redis: RedisService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private tasks: TasksService,
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
   * Продвигает инстанс, пока есть что делать (авто-ноды / неактивированные ожидания).
   * Сериализован Redis-локом на инстанс — параллельные толчки (приёмка задачи + крон)
   * не наступают друг другу на ноги; проигравший лок просто уходит (победитель доведёт).
   */
  async kick(instanceId: string): Promise<void> {
    // TTL 200с: AI-ноды (агент-цикл) могут идти десятки секунд — лок не должен «протухнуть»
    // под работающим шагом (иначе параллельный kick задвоит дорогой LLM-вызов).
    await this.redis.withLock(`process:kick:${instanceId}`, 200_000, async () => {
      for (let i = 0; i < PROCESS_LIMITS.maxAutoChain; i++) {
        const instance = await this.db.processInstance.findUnique({ where: { id: instanceId } });
        if (!instance || instance.status !== 'running') return;

        const plan = await this.getPlan(instance.versionId);
        if (!plan) {
          await this.failInstance(instanceId, null, 'План версии не найден');
          return;
        }

        const activeSteps = await this.db.processStepRun.findMany({
          where: { instanceId, status: 'active' },
          orderBy: { startedAt: 'asc' },
        });
        if (activeSteps.length === 0) {
          // Compiler гарантирует продолжение у каждого выхода — сюда попадать не должны.
          await this.failInstance(instanceId, null, 'Процесс остановился: нет активных шагов');
          return;
        }

        // Что можно исполнить: авто-нода ИЛИ ожидающая нода, чей side-effect ещё не запущен
        // (activated=false). Активированные ожидания (задача/очередь/одобрение/пауза) спят.
        const runnable = activeSteps.find((s) => {
          const node = plan.nodes[s.nodeId];
          if (!node) return true; // исполнение упадёт в failInstance с внятной ошибкой
          return node.auto || !s.activated;
        });
        if (!runnable) return; // все активные шаги ждут людей/времени — токен спит в БД

        // ВАЖНО для параллели: не останавливаем kick на первом ожидании — у развилки
        // несколько веток, каждую надо активировать (создать задачу и т.п.). Шаг,
        // вернувший wait, становится activated=true → на след. итерации не runnable;
        // если инстанс завершился/упал — это поймает проверка статуса в начале цикла.
        await this.executeStep(instance, plan, runnable);
      }
      this.logger.warn(`kick(${instanceId}): исчерпан бюджет авто-цепочки — продолжит крон`);
    });
  }

  /** true → токен продвинулся, цикл продолжается; false → стоп (ожидание/терминал/ошибка). */
  private async executeStep(
    instance: { id: string; versionId: string; workspaceId: string; startedById: string; variables: unknown; definitionId: string },
    plan: CompiledPlan,
    step: { id: string; nodeId: string; joinArrivals?: number },
  ): Promise<boolean> {
    const node = plan.nodes[step.nodeId];
    const provider = node ? this.registry.get(node.type) : undefined;
    if (!node || !provider) {
      await this.failInstance(instance.id, step.id, `Неизвестная нода «${step.nodeId}»`);
      return false;
    }

    try {
      const ctx = await this.buildContext(instance, step, node);
      if (node.join) {
        ctx.join = { arrivals: step.joinArrivals ?? 0, expected: plan.joinExpected[step.nodeId] ?? 1 };
      }
      if (node.cluster) {
        // Ф4.5: собираем кластер агента (подключённые Модель/Память/Инструменты).
        ctx.cluster = await this.buildAgentCluster(instance, plan, step.nodeId, 0);
      }
      const result = await provider.run(ctx);

      if (result.kind === 'wait') {
        const patch = result.patch ?? {};
        try {
          const patched = await this.db.processStepRun.updateMany({
            where: { id: step.id, status: 'active' },
            data: {
              activated: true, // side-effect отработал — kick больше не трогает шаг
              taskId: patch.taskId,
              assigneeId: patch.assigneeId,
              departmentId: patch.departmentId,
              deadlineAt: patch.deadlineAt,
              output: (result.output ?? undefined) as object | undefined,
            },
          });
          if (patched.count === 0 && patch.taskId) {
            // Инстанс отменили/завершили, пока создавалась задача — гасим сироту,
            // иначе исполнитель получит «зомби-работу» отменённого процесса.
            await this.tasks
              .updateTask(instance.startedById, patch.taskId, { status: 'cancelled' })
              .catch(() => undefined);
          }
        } catch (patchErr) {
          if (patch.taskId) {
            await this.tasks
              .updateTask(instance.startedById, patch.taskId, { status: 'cancelled' })
              .catch(() => undefined);
          }
          throw patchErr;
        }
        return false;
      }

      const outcome = await this.completeStepAndAdvance(
        instance.id,
        plan,
        step.id,
        step.nodeId,
        result.outputKey ?? 'main',
        result.output,
      );
      return outcome === 'advanced';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка выполнения ноды';
      await this.failInstance(instance.id, step.id, `${node.label}: ${message}`);
      return false;
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
          completedAt: new Date(),
        },
      });
      if (claimed.count === 0) return 'noop';

      if (node?.terminal) {
        await tx.processInstance.updateMany({
          where: { id: instanceId, status: 'running' },
          data: { status: 'done', finishedAt: new Date() },
        });
        await tx.processStepRun.updateMany({
          where: { instanceId, status: 'active' },
          data: { status: 'cancelled', completedAt: new Date() },
        });
        return 'finished';
      }

      const nextIds = plan.adjacency[nodeId]?.[outputKey] ?? [];
      if (nextIds.length === 0 || nextIds.some((id) => !plan.nodes[id])) {
        await this.markErrorTx(tx, instanceId, null, `Выход «${outputKey}» ноды «${node?.label ?? nodeId}» никуда не ведёт`);
        return 'failed';
      }

      const stepsCount = await tx.processStepRun.count({ where: { instanceId } });
      if (stepsCount + nextIds.length > PROCESS_LIMITS.maxStepsPerInstance) {
        await this.markErrorTx(tx, instanceId, null, 'Превышен лимит шагов процесса (возможен бесконечный цикл)');
        return 'failed';
      }

      // Спавним токен на каждый целевой узел (Развилка = несколько; обычно один).
      for (const nextId of nextIds) {
        const nextNode = plan.nodes[nextId];
        if (nextNode.join) {
          // Слияние: депонируем токен в общий join-шаг (создаём при первом приходе),
          // будим его (activated=false → kick запустит join.run, проверит число прибытий).
          const inc = await tx.processStepRun.updateMany({
            where: { instanceId, nodeId: nextId, status: 'active' },
            data: { joinArrivals: { increment: 1 }, activated: false },
          });
          if (inc.count === 0) {
            await tx.processStepRun.create({
              data: { instanceId, nodeId: nextId, nodeType: nextNode.type, status: 'active', sourceStepId: stepId, joinArrivals: 1 },
            });
          }
        } else {
          await tx.processStepRun.create({
            data: { instanceId, nodeId: nextId, nodeType: nextNode.type, status: 'active', sourceStepId: stepId },
          });
        }
      }
      return 'advanced';
    });

    if (result === 'finished') await this.afterFinished(instanceId);
    if (result === 'failed') await this.afterFailed(instanceId);
    return result;
  }

  // ---------------------------------------------------------------
  // Внешние события (хук Задачника + подстраховка шиной)
  // ---------------------------------------------------------------

  /** Задача процесса полностью принята → шаг done, токен едет дальше. Идемпотентно. */
  async onTaskCompleted(taskId: string): Promise<void> {
    const step = await this.db.processStepRun.findFirst({ where: { taskId, status: 'active' } });
    if (!step) return;
    const instance = await this.db.processInstance.findUnique({ where: { id: step.instanceId } });
    if (!instance || instance.status !== 'running') return;
    const plan = await this.getPlan(instance.versionId);
    if (!plan) return;
    const outcome = await this.completeStepAndAdvance(
      instance.id,
      plan,
      step.id,
      step.nodeId,
      'main',
      { taskId },
    );
    if (outcome === 'advanced') await this.kick(instance.id);
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
      { skipEnvironmentChecks: true },
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
    const outcome = await this.completeStepAndAdvance(instance.id, plan, step.id, step.nodeId, decision, { decision }, { decision });
    if (outcome === 'advanced') await this.kick(instance.id);
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
        const outcome = await this.completeStepAndAdvance(instance.id, plan, s.id, s.nodeId, 'main', { kind: 'delay' });
        if (outcome === 'advanced') await this.kick(instance.id);
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
      include: { definition: { select: { name: true } } },
    });
    if (!instance) return;
    await this.notifications
      .notify(
        instance.startedById,
        'process.failed',
        { processName: instance.definition.name, error: instance.error ?? '' },
        { actionUrl: `/workspaces/${instance.workspaceId}/processes/instances/${instanceId}` },
      )
      .catch(() => undefined);
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
    if (cached) return cached;
    const version = await this.db.processVersion.findUnique({ where: { id: versionId } });
    const plan = (version?.compiled as CompiledPlan | null) ?? null;
    if (plan) this.cachePlan(versionId, plan);
    return plan;
  }

  /** Кэш планов с потолком (версии копятся вечно — publish создаёт новую каждый раз). */
  private cachePlan(versionId: string, plan: CompiledPlan): void {
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
      memory = {
        load: async () => {
          const turns = (await this.redis.getJson<{ u: string; a: string }[]>(key)) ?? [];
          return turns.map((t) => `Пользователь: ${t.u}\nАгент: ${t.a}`).join('\n\n');
        },
        append: async (u, a) => {
          const turns = (await this.redis.getJson<{ u: string; a: string }[]>(key)) ?? [];
          turns.push({ u: u.slice(0, 2000), a: a.slice(0, 2000) });
          await this.redis.setJson(key, turns.slice(-window), 7 * 24 * 3600);
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

  private async buildContext(
    instance: { id: string; workspaceId: string; startedById: string; variables: unknown; definitionId: string },
    step: { id: string; nodeId: string },
    node: { label: string; config: Record<string, unknown> },
  ): Promise<NodeRunContext> {
    const [starter, definition, doneSteps] = await Promise.all([
      this.db.user.findUnique({
        where: { id: instance.startedById },
        select: { firstName: true, lastName: true },
      }),
      this.db.processDefinition.findUnique({
        where: { id: instance.definitionId },
        select: { name: true },
      }),
      // Результаты завершённых шагов — для подстановок {{steps.<nodeId>.output...}} (AI/сервисные ноды).
      this.db.processStepRun.findMany({
        where: { instanceId: instance.id, status: 'done' },
        select: { nodeId: true, output: true, completedAt: true },
        orderBy: { completedAt: 'asc' },
      }),
    ]);
    const variables = (instance.variables ?? {}) as Record<string, unknown>;
    const steps: Record<string, unknown> = {};
    for (const s of doneSteps) if (s.output !== null) steps[s.nodeId] = s.output; // последний завершённый выигрывает
    const renderCtx: Record<string, unknown> = {
      form: variables,
      steps,
      initiator: { name: [starter?.firstName, starter?.lastName].filter(Boolean).join(' ') },
      instance: { name: definition?.name ?? 'Процесс' },
    };
    return {
      instanceId: instance.id,
      workspaceId: instance.workspaceId,
      startedById: instance.startedById,
      definitionName: definition?.name ?? 'Процесс',
      variables,
      step: { id: step.id, nodeId: step.nodeId, label: node.label },
      config: node.config,
      render: (text: string) => renderTemplate(text, renderCtx),
      deps: { tasks: this.tasks, notifications: this.notifications, db: this.db },
    };
  }
}

/** Подстановки `{{form.budget}}` — только path-lookup по СОБСТВЕННЫМ свойствам, без eval. */
function renderTemplate(text: string, ctx: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (!acc || typeof acc !== 'object') return undefined;
      // own-property only: {{form.constructor}} не должен доставать прототипные функции
      return Object.prototype.hasOwnProperty.call(acc, key)
        ? (acc as Record<string, unknown>)[key]
        : undefined;
    }, ctx);
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
