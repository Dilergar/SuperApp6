import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  PROCESS_LIMITS,
  WORKSPACE_ROLE_RANK,
  type ProcessDefinitionDetailDto,
  type ProcessDefinitionDto,
  type ProcessDocument,
  type ProcessFormField,
  type ProcessInstanceDetailDto,
  type ProcessInstanceDto,
  type ProcessNodeTypeDto,
  type ProcessStepDto,
  type ProcessUserMini,
  type ProcessValidationIssue,
  type WorkspaceRole,
} from '@superapp/shared';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { encryptSecret, decryptSecret } from './process-crypto';
import { ProcessNodeRegistry } from './process-node.registry';
import { ProcessEngineService } from './process-engine.service';
import { compileProcessDocument } from './process-compiler';
import { BUILTIN_PROCESS_NODES } from './process-builtin-nodes';
import { SERVICE_PROCESS_NODES, fetchJson } from './process-service-nodes';
import { AI_PROCESS_NODES } from './process-ai-nodes';
import { KZ_PROCESS_NODES } from './process-kz-nodes';
import { ACTION_PROCESS_NODES } from './process-action-nodes';
import type { CompiledPlan } from './process-node.types';

const WS_CONTEXT = 'workspace';

/**
 * Поля шага для карточки/статуса инстанса — БЕЗ тяжёлого `output` (AI/HTTP-блобы) (P7):
 * getInstance и тонкий статус-эндпоинт тянут только нужное, не мегабайты на автообновлении.
 */
const INSTANCE_STEP_SELECT = {
  id: true,
  nodeId: true,
  nodeType: true,
  label: true,
  status: true,
  startedAt: true,
  completedAt: true,
  outcome: true,
  error: true,
  taskId: true,
  assigneeId: true,
  departmentId: true,
  deadlineAt: true,
  decision: true,
} satisfies Prisma.ProcessStepRunSelect;

type InstanceStepRow = Prisma.ProcessStepRunGetPayload<{ select: typeof INSTANCE_STEP_SELECT }>;

/** Стартовый документ нового процесса: триггер «Запуск вручную» → Конец (публикуется из коробки). */
const DEFAULT_DOCUMENT: ProcessDocument = {
  nodes: [
    { id: 'start', type: 'start', label: 'Запуск вручную', config: {}, position: { x: 60, y: 220 } },
    { id: 'end', type: 'end', label: 'Конец', config: {}, position: { x: 620, y: 220 } },
  ],
  edges: [{ id: 'e_start_end', from: 'start', fromPort: 'main', to: 'end' }],
  form: [],
};

/** База API для публичных URL вебхуков (внешние системы дёргают /api/processes/webhook/:token). */
function apiBaseUrl(): string {
  return (process.env.API_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
}

/** Тип триггер-ноды документа → тип строки ProcessTrigger. */
const TRIGGER_NODE_TYPE: Record<string, 'schedule' | 'webhook' | 'event' | 'telegram'> = {
  'trigger.schedule': 'schedule',
  'trigger.webhook': 'webhook',
  'trigger.event': 'event',
  'trigger.telegram': 'telegram',
};

/** Локальный адрес (вебхуки Telegram/Meta до него не достучатся) — авто-регистрацию пропускаем. */
function isLocalBase(base: string): boolean {
  return /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/i.test(base);
}

/**
 * Сервис «Процессы» (B2B): определения + версии (publish/pin) + запуск/журнал.
 * Гейты — по лестнице ролей организации (модель Staff): читает/запускает команда
 * (trainee+, Подрядчик изолирован), редактирует manager+, visibility 'admins' — admin+.
 */
@Injectable()
export class ProcessesService implements OnModuleInit {
  private readonly runawayLogger = new Logger(ProcessesService.name);

  constructor(
    private db: DatabaseService,
    private roles: RolesService,
    private registry: ProcessNodeRegistry,
    private engine: ProcessEngineService,
  ) {}

  onModuleInit(): void {
    for (const provider of [...BUILTIN_PROCESS_NODES, ...SERVICE_PROCESS_NODES, ...AI_PROCESS_NODES, ...KZ_PROCESS_NODES, ...ACTION_PROCESS_NODES]) {
      this.registry.register(provider);
    }
  }

  // ---------------------------------------------------------------
  // Гейты (лестница ролей организации, как в StaffService)
  // ---------------------------------------------------------------

  private async getRoleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  private async assertTeamMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.getRoleOf(userId, workspaceId);
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    if (role === 'contractor') {
      throw new ForbiddenException('Подрядчику доступны только его задачи');
    }
    return role;
  }

  private async assertManage(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.assertTeamMember(userId, workspaceId);
    if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
      throw new ForbiddenException('Недостаточно прав (нужен Менеджер или выше)');
    }
    return role;
  }

  private canSeeDefinition(role: WorkspaceRole, visibility: string): boolean {
    if (visibility !== 'admins') return true;
    return (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.admin;
  }

  /** Стена «только админы» действует и на ПРАВКУ: менеджер не видит → не редактирует/не публикует. */
  private assertDefVisible(role: WorkspaceRole, def: { visibility: string }): void {
    if (!this.canSeeDefinition(role, def.visibility)) {
      throw new ForbiddenException('Процесс доступен только администраторам');
    }
  }

  /** Платформенная роль (Universal Identity, context='system') — открывает system-ноды. */
  private isPlatformAdmin(userId: string): Promise<boolean> {
    return this.roles.hasRole(userId, 'platform_admin', 'system');
  }

  // ---------------------------------------------------------------
  // Палитра нод
  // ---------------------------------------------------------------

  async listNodeTypes(userId: string, workspaceId: string): Promise<ProcessNodeTypeDto[]> {
    await this.assertTeamMember(userId, workspaceId);
    const includeSystem = await this.isPlatformAdmin(userId);
    return this.registry.listTypes(includeSystem);
  }

  // ---------------------------------------------------------------
  // Определения процессов
  // ---------------------------------------------------------------

  async listDefinitions(userId: string, workspaceId: string): Promise<ProcessDefinitionDto[]> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const defs = await this.db.processDefinition.findMany({
      where: { workspaceId, status: 'active' },
      orderBy: { updatedAt: 'desc' },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, status: true } },
      },
    });
    const visible = defs.filter((d) => this.canSeeDefinition(role, d.visibility));
    const runningCounts = await this.db.processInstance.groupBy({
      by: ['definitionId'],
      where: { workspaceId, status: 'running' },
      _count: { _all: true },
    });
    const runningByDef = new Map(runningCounts.map((r) => [r.definitionId, r._count._all]));
    return visible.map((d) => this.toDefinitionDto(d, runningByDef.get(d.id) ?? 0));
  }

  async createDefinition(
    userId: string,
    workspaceId: string,
    data: { name: string; description?: string | null },
  ): Promise<ProcessDefinitionDetailDto> {
    await this.assertManage(userId, workspaceId);
    const def = await this.db.$transaction(async (tx) => {
      const created = await tx.processDefinition.create({
        data: {
          workspaceId,
          name: data.name,
          description: data.description ?? null,
          createdById: userId,
        },
      });
      await tx.processVersion.create({
        data: {
          definitionId: created.id,
          version: 1,
          status: 'draft',
          document: DEFAULT_DOCUMENT as unknown as object,
          createdById: userId,
        },
      });
      return created;
    });
    return this.getDefinition(userId, workspaceId, def.id);
  }

  async getDefinition(
    userId: string,
    workspaceId: string,
    definitionId: string,
  ): Promise<ProcessDefinitionDetailDto> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const def = await this.loadDefinition(workspaceId, definitionId);
    this.assertDefVisible(role, def);
    // Метаданные версий — без тяжёлых JSON-колонок; документ грузим только у последней.
    const versionsMeta = await this.db.processVersion.findMany({
      where: { definitionId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, status: true, publishedAt: true },
    });
    const latestMeta = versionsMeta[0];
    if (!latestMeta) throw new NotFoundException('У процесса нет версий');
    const latest = await this.db.processVersion.findUnique({
      where: { id: latestMeta.id },
      select: { document: true },
    });
    const document = (latest?.document ?? { nodes: [], edges: [], form: [] }) as unknown as ProcessDocument;
    const { issues } = compileProcessDocument(document, this.registry);
    const runningCount = await this.db.processInstance.count({
      where: { definitionId, status: 'running' },
    });
    const published = versionsMeta.find((v) => v.status === 'published');
    // Форма ЗАПУСКА — из опубликованной версии (черновик может отличаться; модалка
    // запуска должна показывать именно то, что провалидирует сервер).
    let startForm: ProcessDocument['form'] | null = null;
    if (def.currentVersionId) {
      const pub = await this.db.processVersion.findUnique({
        where: { id: def.currentVersionId },
        select: { document: true },
      });
      startForm = pub ? ((pub.document as unknown as ProcessDocument).form ?? []) : null;
    }
    // Триггер-ноды (синхронизируются в ProcessTrigger при публикации) — для показа
    // webhook-URL/статуса в панели соответствующей ноды на канвасе.
    const triggerRows = await this.db.processTrigger.findMany({ where: { definitionId } });
    const base = apiBaseUrl();
    const triggers = triggerRows.map((t) => {
      const cfg = (t.config ?? {}) as { nodeId?: string };
      // Telegram-вебхук слушается на отдельном пути (там разбирается Telegram-апдейт).
      const webhookPath = t.type === 'telegram' ? 'webhook/telegram' : 'webhook';
      return {
        nodeId: cfg.nodeId ?? '',
        type: t.type as 'schedule' | 'webhook' | 'event' | 'telegram',
        enabled: t.enabled,
        webhookUrl: t.webhookToken ? `${base}/api/processes/${webhookPath}/${t.webhookToken}` : null,
        nextRunAt: t.nextRunAt?.toISOString() ?? null,
        lastRunAt: t.lastRunAt?.toISOString() ?? null,
      };
    });

    const canEdit = (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
    return {
      ...this.toDefinitionDto(
        { ...def, versions: [{ version: latestMeta.version, status: latestMeta.status }] },
        runningCount,
      ),
      publishedVersion: published?.version ?? null,
      document,
      startForm,
      triggers,
      editableVersion: latestMeta.version,
      editableVersionStatus: latestMeta.status as ProcessDefinitionDetailDto['editableVersionStatus'],
      versions: versionsMeta.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status as ProcessDefinitionDetailDto['versions'][number]['status'],
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
      issues,
      canEdit,
      canStart: !!def.currentVersionId,
    };
  }

  async updateDefinition(
    userId: string,
    workspaceId: string,
    definitionId: string,
    data: { name?: string; description?: string | null; visibility?: 'team' | 'admins' },
  ): Promise<void> {
    const role = await this.assertManage(userId, workspaceId);
    this.assertDefVisible(role, await this.loadDefinition(workspaceId, definitionId));
    await this.db.processDefinition.update({
      where: { id: definitionId },
      data: {
        name: data.name,
        description: data.description,
        visibility: data.visibility,
      },
    });
  }

  /**
   * Сохранить документ. Правка опубликованной версии автоматически открывает новый
   * черновик (publish = новая версия, активна одна — модель Salesforce Flow).
   * Возвращает мягкую валидацию (сохранению не мешает, публикации — да).
   */
  async saveDocument(
    userId: string,
    workspaceId: string,
    definitionId: string,
    document: ProcessDocument,
  ): Promise<{ version: number; issues: ProcessValidationIssue[] }> {
    const role = await this.assertManage(userId, workspaceId);
    this.assertDefVisible(role, await this.loadDefinition(workspaceId, definitionId));

    const saved = await this.db.$transaction(async (tx) => {
      const latest = await tx.processVersion.findFirst({
        where: { definitionId },
        orderBy: { version: 'desc' },
      });
      if (!latest) throw new NotFoundException('У процесса нет версий');
      if (latest.status === 'draft') {
        await tx.processVersion.update({
          where: { id: latest.id },
          data: { document: document as unknown as object },
        });
        return latest.version;
      }
      const next = await tx.processVersion.create({
        data: {
          definitionId,
          version: latest.version + 1,
          status: 'draft',
          document: document as unknown as object,
          createdById: userId,
        },
      });
      return next.version;
    });

    const { issues } = compileProcessDocument(document, this.registry);
    return { version: saved, issues };
  }

  async validateDefinition(
    userId: string,
    workspaceId: string,
    definitionId: string,
  ): Promise<{ issues: ProcessValidationIssue[] }> {
    const role = await this.assertTeamMember(userId, workspaceId);
    this.assertDefVisible(role, await this.loadDefinition(workspaceId, definitionId));
    const latest = await this.latestVersion(definitionId);
    const { issues } = compileProcessDocument(
      latest.document as unknown as ProcessDocument,
      this.registry,
    );
    const memberIssues = await this.validateMembers(
      workspaceId,
      latest.document as unknown as ProcessDocument,
    );
    return { issues: [...issues, ...memberIssues] };
  }

  /** Публикация: компиляция без ошибок + исполнители — действующие члены команды. */
  async publish(
    userId: string,
    workspaceId: string,
    definitionId: string,
  ): Promise<ProcessDefinitionDetailDto> {
    const role = await this.assertManage(userId, workspaceId);
    this.assertDefVisible(role, await this.loadDefinition(workspaceId, definitionId));
    const latest = await this.latestVersion(definitionId);
    if (latest.status !== 'draft') {
      throw new BadRequestException('Нет черновика для публикации — внесите изменения');
    }
    const document = latest.document as unknown as ProcessDocument;
    const { plan, issues } = compileProcessDocument(document, this.registry);
    const memberIssues = await this.validateMembers(workspaceId, document);
    const all = [...issues, ...memberIssues];
    if (!plan || all.length > 0) {
      throw new BadRequestException({
        message: 'Процесс не готов к публикации',
        errors: all.map((i) => ({ field: i.nodeId ?? i.edgeId ?? 'document', message: i.message })),
      });
    }

    await this.db.$transaction(async (tx) => {
      await tx.processVersion.updateMany({
        where: { definitionId, status: 'published' },
        data: { status: 'superseded' },
      });
      await tx.processVersion.update({
        where: { id: latest.id },
        data: { status: 'published', publishedAt: new Date(), compiled: plan as unknown as object },
      });
      await tx.processDefinition.update({
        where: { id: definitionId },
        data: { currentVersionId: latest.id },
      });
      // Триггер-ноды холста → строки ProcessTrigger (роутер/крон/вебхук читают их).
      await this.syncTriggersOnPublish(tx, definitionId, workspaceId, document, userId);
    });
    // Авто-регистрация вебхуков Telegram-ботов (вне транзакции — внешний вызов; best-effort).
    await this.registerTelegramWebhooks(definitionId).catch(() => undefined);
    return this.getDefinition(userId, workspaceId, definitionId);
  }

  /** Архивировать (мягко). Запущенные инстансы блокируют — как удаление справочников Staff. */
  async archiveDefinition(userId: string, workspaceId: string, definitionId: string): Promise<void> {
    const role = await this.assertManage(userId, workspaceId);
    this.assertDefVisible(role, await this.loadDefinition(workspaceId, definitionId));
    const running = await this.db.processInstance.count({
      where: { definitionId, status: 'running' },
    });
    if (running > 0) {
      throw new ConflictException(`Есть запущенные процессы (${running}) — сначала дождитесь или отмените их`);
    }
    await this.db.processDefinition.update({
      where: { id: definitionId },
      data: { status: 'archived' },
    });
  }

  // ---------------------------------------------------------------
  // Инстансы
  // ---------------------------------------------------------------

  async startInstance(
    userId: string,
    workspaceId: string,
    definitionId: string,
    input: Record<string, unknown>,
  ): Promise<ProcessInstanceDetailDto> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const def = await this.loadDefinition(workspaceId, definitionId);
    if (!this.canSeeDefinition(role, def.visibility)) {
      throw new ForbiddenException('Процесс доступен только администраторам');
    }
    if (!def.currentVersionId) {
      throw new BadRequestException('Процесс ещё не опубликован');
    }
    const version = await this.db.processVersion.findUnique({ where: { id: def.currentVersionId } });
    if (!version || version.status !== 'published' || !version.compiled) {
      throw new BadRequestException('Опубликованная версия не найдена');
    }
    const plan = version.compiled as unknown as CompiledPlan;
    const variables = this.validateFormInput(plan.form, input);

    const instanceId = await this.engine.startInstance({
      definitionId,
      versionId: version.id,
      workspaceId,
      starterId: userId,
      variables,
      plan,
    });
    return this.getInstance(userId, workspaceId, instanceId);
  }

  async listInstances(
    userId: string,
    workspaceId: string,
    filter: { definitionId?: string; status?: string },
  ): Promise<ProcessInstanceDto[]> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const rank = WORKSPACE_ROLE_RANK[role] ?? 0;
    const isManager = rank >= WORKSPACE_ROLE_RANK.manager;
    const isAdmin = rank >= WORKSPACE_ROLE_RANK.admin;
    const participantFilter = [
      { startedById: userId },
      { steps: { some: { assigneeId: userId } } },
    ];
    const instances = await this.db.processInstance.findMany({
      where: {
        workspaceId,
        definitionId: filter.definitionId,
        status: filter.status,
        // Рядовой видит свои/где исполнитель; менеджер — все, КРОМЕ admins-процессов
        // (их журнал — только админам и участникам); админ — всё.
        ...(isAdmin
          ? {}
          : isManager
            ? { OR: [{ definition: { visibility: { not: 'admins' } } }, ...participantFilter] }
            : { OR: participantFilter }),
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
      include: {
        definition: { select: { name: true } },
        version: { select: { version: true } },
        // P7: подпись берём из снимка на шаге (label), НЕ парсим документы версий.
        steps: { where: { status: 'active' }, select: { nodeId: true, label: true } },
      },
    });
    const userIds = [...new Set(instances.map((i) => i.startedById))];
    const users = await this.userMinis(userIds);
    return instances.map((i) =>
      this.toInstanceDto(i, users, i.steps.map((s) => s.label ?? s.nodeId)),
    );
  }

  async getInstance(
    userId: string,
    workspaceId: string,
    instanceId: string,
  ): Promise<ProcessInstanceDetailDto> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({
      where: { id: instanceId },
      include: {
        definition: { select: { name: true, visibility: true } },
        version: { select: { version: true, document: true } },
        // P7: без тяжёлого output-блоба (детали читаются, в т.ч. на 4с-автообновлении).
        steps: { orderBy: { startedAt: 'asc' }, select: INSTANCE_STEP_SELECT },
      },
    });
    if (!instance || instance.workspaceId !== workspaceId) {
      throw new NotFoundException('Процесс не найден');
    }
    const managerAllowed = this.assertInstanceAccess(role, instance.definition.visibility, instance.startedById, instance.steps, userId);

    const view = await this.stepViewContext(instance.steps, instance.startedById, userId);
    const steps = this.mapSteps(instance.steps, { ...view, managerAllowed, userId, now: Date.now() });
    const activeLabels = instance.steps.filter((s) => s.status === 'active').map((s) => s.label ?? s.nodeId);

    return {
      ...this.toInstanceDto(instance, view.users, activeLabels),
      variables: (instance.variables ?? {}) as Record<string, unknown>,
      document: instance.version.document as unknown as ProcessDocument,
      steps,
      canCancel:
        instance.status === 'running' && (managerAllowed || instance.startedById === userId),
    };
  }

  /**
   * Тонкий статус инстанса (P7): только волатильные поля (статус + шаги без output-блобов,
   * подписи из снимка label), БЕЗ документа/анкеты — для 4с-поллинга. Полную деталь фронт
   * тянет один раз (getInstance), а обновления берёт отсюда.
   */
  async getInstanceStatus(userId: string, workspaceId: string, instanceId: string): Promise<import('@superapp/shared').ProcessInstanceStatusDto> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        status: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        startedById: true,
        workspaceId: true,
        definition: { select: { visibility: true } },
        steps: { orderBy: { startedAt: 'asc' }, select: INSTANCE_STEP_SELECT },
      },
    });
    if (!instance || instance.workspaceId !== workspaceId) {
      throw new NotFoundException('Процесс не найден');
    }
    const managerAllowed = this.assertInstanceAccess(role, instance.definition.visibility, instance.startedById, instance.steps, userId);
    const view = await this.stepViewContext(instance.steps, instance.startedById, userId);
    const steps = this.mapSteps(instance.steps, { ...view, managerAllowed, userId, now: Date.now() });
    return {
      id: instance.id,
      status: instance.status as import('@superapp/shared').ProcessInstanceStatusDto['status'],
      error: instance.error,
      finishedAt: instance.finishedAt?.toISOString() ?? null,
      durationMs: instance.finishedAt ? instance.finishedAt.getTime() - instance.startedAt.getTime() : null,
      currentSteps: instance.steps.filter((s) => s.status === 'active').map((s) => s.label ?? s.nodeId),
      steps,
      canCancel: instance.status === 'running' && (managerAllowed || instance.startedById === userId),
    };
  }

  /** Доступ к инстансу: бросает 403 если нельзя; возвращает managerAllowed (для canCancel/canReassign). */
  private assertInstanceAccess(
    role: WorkspaceRole,
    visibility: string,
    startedById: string,
    steps: { assigneeId: string | null }[],
    userId: string,
  ): boolean {
    const rank = WORKSPACE_ROLE_RANK[role] ?? 0;
    const isManager = rank >= WORKSPACE_ROLE_RANK.manager;
    const isAdmin = rank >= WORKSPACE_ROLE_RANK.admin;
    const participates = startedById === userId || steps.some((s) => s.assigneeId === userId);
    // Участник видит свой процесс всегда; менеджеру admins-процессы закрыты.
    const managerAllowed = isManager && (isAdmin || visibility !== 'admins');
    if (!managerAllowed && !participates) {
      throw new ForbiddenException('Нет доступа к этому процессу');
    }
    return managerAllowed;
  }

  /** Имена участников + имена отделов + отделы-членства зрителя (для карточки/статуса инстанса). */
  private async stepViewContext(steps: InstanceStepRow[], startedById: string, userId: string) {
    const userIds = [...new Set([startedById, ...steps.map((s) => s.assigneeId).filter((x): x is string => !!x)])];
    const users = await this.userMinis(userIds);
    const deptIds = [...new Set(steps.map((s) => s.departmentId).filter((x): x is string => !!x))];
    const deptNames = new Map<string, string>();
    const viewerDepts = new Set<string>();
    if (deptIds.length) {
      const deps = await this.db.staffDepartment.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } });
      for (const d of deps) deptNames.set(d.id, d.name);
      const mine = await this.db.relationTuple.findMany({
        where: { resourceType: 'department', resourceId: { in: deptIds }, relation: 'member', subjectType: 'user', subjectId: userId },
        select: { resourceId: true },
      });
      for (const m of mine) viewerDepts.add(m.resourceId);
    }
    return { users, deptNames, viewerDepts };
  }

  /** Снимок шагов инстанса → DTO (подпись из label-снимка; overdue/canClaim/canDecide/canReassign). */
  private mapSteps(
    steps: InstanceStepRow[],
    ctx: { users: Map<string, ProcessUserMini>; deptNames: Map<string, string>; viewerDepts: Set<string>; managerAllowed: boolean; userId: string; now: number },
  ): ProcessStepDto[] {
    return steps.map((s) => {
      const overdue = s.status === 'active' && !!s.deadlineAt && s.deadlineAt.getTime() <= ctx.now && s.nodeType !== 'delay';
      const isQueued = s.status === 'active' && !!s.departmentId && !s.taskId;
      return {
        id: s.id,
        nodeId: s.nodeId,
        nodeType: s.nodeType,
        label: s.label ?? s.nodeId,
        status: s.status as ProcessStepDto['status'],
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        durationMs: s.completedAt ? s.completedAt.getTime() - s.startedAt.getTime() : null,
        outcome: s.outcome,
        error: s.error,
        taskId: s.taskId,
        assignee: s.assigneeId ? (ctx.users.get(s.assigneeId) ?? null) : null,
        departmentId: s.departmentId,
        departmentName: s.departmentId ? (ctx.deptNames.get(s.departmentId) ?? null) : null,
        deadlineAt: s.deadlineAt?.toISOString() ?? null,
        overdue,
        decision: (s.decision as 'approved' | 'rejected' | null) ?? null,
        canClaim: isQueued && ctx.viewerDepts.has(s.departmentId!),
        canDecide: s.status === 'active' && s.nodeType === 'human.approval' && s.assigneeId === ctx.userId && !s.decision,
        canReassign: ctx.managerAllowed && s.status === 'active' && !!s.taskId,
      };
    });
  }

  async cancelInstance(userId: string, workspaceId: string, instanceId: string): Promise<void> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({
      where: { id: instanceId },
      include: { definition: { select: { visibility: true } } },
    });
    if (!instance || instance.workspaceId !== workspaceId) {
      throw new NotFoundException('Процесс не найден');
    }
    const rank = WORKSPACE_ROLE_RANK[role] ?? 0;
    const managerAllowed =
      rank >= WORKSPACE_ROLE_RANK.manager &&
      (rank >= WORKSPACE_ROLE_RANK.admin || instance.definition.visibility !== 'admins');
    if (!managerAllowed && instance.startedById !== userId) {
      throw new ForbiddenException('Отменить может инициатор или менеджер');
    }
    const ok = await this.engine.cancelInstance(instanceId, userId);
    if (!ok) throw new BadRequestException('Процесс уже завершён');
  }

  /** Хук Задачника (ModuleRef-токен 'ProcessesService', как ShopService.onFulfillmentDone). */
  async onTaskCompleted(taskId: string): Promise<void> {
    await this.engine.onTaskCompleted(taskId);
  }

  async onTaskCancelled(taskId: string): Promise<void> {
    await this.engine.onTaskCancelled(taskId);
  }

  // ---------------------------------------------------------------
  // Ф3: программный запуск (для триггеров — событие/расписание/вебхук)
  // ---------------------------------------------------------------

  /**
   * Запустить опубликованный процесс «от имени» runAsUserId с готовыми переменными
   * (лениво: значения по форме коэрсятся, лишние отбрасываются, required не валим —
   * у триггеров формы обычно пустые/частичные). Возвращает id инстанса или null.
   */
  async startInstanceProgrammatic(
    definitionId: string,
    runAsUserId: string,
    rawVariables: Record<string, unknown>,
    triggerType: 'event' | 'schedule' | 'webhook' | 'telegram',
    entryNodeId?: string,
  ): Promise<string | null> {
    const def = await this.db.processDefinition.findUnique({ where: { id: definitionId } });
    if (!def || def.status !== 'active' || !def.currentVersionId) return null;
    const version = await this.db.processVersion.findUnique({ where: { id: def.currentVersionId } });
    if (!version || version.status !== 'published' || !version.compiled) return null;

    // Анти-runaway (A4): бюджет одновременно бегущих инстансов на воркспейс — лавина
    // авто-триггеров (петля событий/расписание) упирается в потолок, а не кладёт систему.
    const running = await this.db.processInstance.count({ where: { workspaceId: def.workspaceId, status: 'running' } });
    if (running >= PROCESS_LIMITS.maxRunningInstancesPerWorkspace) {
      this.runawayLogger.warn(
        `startInstanceProgrammatic: воркспейс ${def.workspaceId} на потолке бегущих инстансов (${running}) — авто-запуск ${definitionId} пропущен`,
      );
      return null;
    }

    const plan = version.compiled as unknown as CompiledPlan;

    // Лениво по форме: берём только распознанные поля; остальное кладём как есть (для {{form.x}}).
    const variables: Record<string, unknown> = { ...rawVariables };
    for (const f of plan.form) {
      const raw = rawVariables[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw === 'object') continue;
      if (f.type === 'number') {
        const n = Number(raw);
        if (!Number.isNaN(n)) variables[f.key] = n;
      } else if (f.type === 'boolean') {
        variables[f.key] = raw === true || raw === 'true' || raw === 'да';
      } else {
        variables[f.key] = String(raw);
      }
    }

    const instanceId = await this.engine.startInstance({
      definitionId,
      versionId: version.id,
      workspaceId: def.workspaceId,
      starterId: runAsUserId,
      variables,
      plan,
      triggerType,
      entryNodeId,
    });
    return instanceId;
  }

  /**
   * Ф3: запустить под-процесс ТОЙ ЖЕ организации от имени actor (нода «Запустить процесс»).
   * Same-workspace + защита от рекурсии по глубине; бюджет инстансов — в startInstanceProgrammatic.
   */
  async startSubprocess(
    callerWorkspaceId: string,
    definitionId: string,
    actorUserId: string,
    variables: Record<string, unknown>,
    depth: number,
  ): Promise<string | null> {
    if (depth > PROCESS_LIMITS.maxSubprocessDepth) {
      throw new BadRequestException('Слишком глубокая вложенность под-процессов');
    }
    const def = await this.db.processDefinition.findUnique({ where: { id: definitionId }, select: { workspaceId: true } });
    if (!def || def.workspaceId !== callerWorkspaceId) {
      throw new BadRequestException('Под-процесс не найден в этой организации');
    }
    return this.startInstanceProgrammatic(definitionId, actorUserId, { ...variables, _subprocessDepth: depth }, 'event');
  }

  // ---------------------------------------------------------------
  // Триггеры запуска = НОДЫ канваса (модель n8n). Авто-триггеры (расписание/вебхук/
  // событие) синхронизируются в таблицу ProcessTrigger при ПУБЛИКАЦИИ; роутер/крон/
  // вебхук читают строки и стартуют с нужной триггер-ноды (entryNodeId = config.nodeId).
  // ---------------------------------------------------------------

  /** Зеркалит триггер-ноды документа в ProcessTrigger (в транзакции публикации). */
  private async syncTriggersOnPublish(
    tx: Pick<DatabaseService, 'processTrigger'>,
    definitionId: string,
    workspaceId: string,
    document: ProcessDocument,
    publishedById: string,
  ): Promise<void> {
    const triggerNodes = document.nodes.filter((n) => TRIGGER_NODE_TYPE[n.type]);
    const existing = await tx.processTrigger.findMany({ where: { definitionId } });
    const byNodeId = new Map(existing.map((t) => [((t.config ?? {}) as { nodeId?: string }).nodeId, t]));
    const keep = new Set<string>();

    for (const n of triggerNodes) {
      keep.add(n.id);
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const runAsUserId = String(cfg.runAsUserId ?? '');
      const type = TRIGGER_NODE_TYPE[n.type];
      const prev = byNodeId.get(n.id);

      if (type === 'schedule') {
        const everyValue = Math.max(1, Number(cfg.everyValue ?? 1));
        const everyUnit = cfg.everyUnit === 'days' ? 'days' : 'hours';
        const ms = everyValue * (everyUnit === 'days' ? 86_400_000 : 3_600_000);
        const config = { nodeId: n.id, everyValue, everyUnit };
        if (prev) {
          await tx.processTrigger.update({
            where: { id: prev.id },
            data: { type, config, runAsUserId, enabled: true, nextRunAt: prev.nextRunAt ?? new Date(Date.now() + ms) },
          });
        } else {
          await tx.processTrigger.create({
            data: { definitionId, workspaceId, type, config, runAsUserId, enabled: true, nextRunAt: new Date(Date.now() + ms), createdById: publishedById },
          });
        }
      } else if (type === 'event') {
        const eventType = String(cfg.eventType ?? '');
        // + entry-condition (Ф2/sfflow#1): роутер фильтрует payload до старта.
        const config = {
          nodeId: n.id,
          eventType,
          condField: cfg.condField ? String(cfg.condField) : undefined,
          condOp: cfg.condOp ? String(cfg.condOp) : undefined,
          condValue: cfg.condValue != null && cfg.condValue !== '' ? String(cfg.condValue) : undefined,
        };
        // eventType дублируем в колонку (P4): роутер фильтрует индексом, а не JSONB-path.
        if (prev) {
          await tx.processTrigger.update({ where: { id: prev.id }, data: { type, config, eventType, runAsUserId, enabled: true } });
        } else {
          await tx.processTrigger.create({ data: { definitionId, workspaceId, type, config, eventType, runAsUserId, enabled: true, createdById: publishedById } });
        }
      } else if (type === 'webhook') {
        // webhook — токен стабилен между публикациями (внешний URL не должен «протухать»).
        const config = { nodeId: n.id };
        if (prev) {
          await tx.processTrigger.update({ where: { id: prev.id }, data: { type, config, runAsUserId, enabled: true } });
        } else {
          await tx.processTrigger.create({
            data: { definitionId, workspaceId, type, config, runAsUserId, enabled: true, webhookToken: randomBytes(24).toString('base64url'), createdById: publishedById },
          });
        }
      } else {
        // telegram — вебхук бота: токен пути стабилен; credentialId (токен @BotFather) в config.
        const config = { nodeId: n.id, credentialId: String(cfg.credentialId ?? '') };
        if (prev) {
          await tx.processTrigger.update({ where: { id: prev.id }, data: { type, config, runAsUserId, enabled: true } });
        } else {
          await tx.processTrigger.create({
            data: { definitionId, workspaceId, type, config, runAsUserId, enabled: true, webhookToken: randomBytes(24).toString('base64url'), createdById: publishedById },
          });
        }
      }
    }

    // Триггер-ноды, удалённые с холста → убираем их строки.
    const stale = existing.filter((t) => !keep.has(((t.config ?? {}) as { nodeId?: string }).nodeId ?? ''));
    if (stale.length) await tx.processTrigger.deleteMany({ where: { id: { in: stale.map((t) => t.id) } } });
  }

  /**
   * Best-effort: регистрирует вебхук Telegram-бота на наш приёмник (модель n8n: при
   * активации зовём setWebhook). На localhost пропускаем (Telegram требует публичный
   * HTTPS) — URL виден в панели ноды для ручной настройки. Ошибки не валят публикацию.
   */
  private async registerTelegramWebhooks(definitionId: string): Promise<void> {
    const base = apiBaseUrl();
    const rows = await this.db.processTrigger.findMany({ where: { definitionId, type: 'telegram', enabled: true } });
    if (rows.length === 0) return;
    if (isLocalBase(base)) return; // публичного адреса нет — Telegram не достучится; настроить вручную
    for (const t of rows) {
      try {
        const cfg = (t.config ?? {}) as { credentialId?: string };
        if (!cfg.credentialId || !t.webhookToken) continue;
        const cred = await this.db.processCredential.findUnique({ where: { id: cfg.credentialId } });
        if (!cred) continue;
        const secret = JSON.parse(decryptSecret(cred.data)) as { token?: string };
        if (!secret.token) continue;
        const url = `${base}/api/processes/webhook/telegram/${t.webhookToken}`;
        await fetchJson(`https://api.telegram.org/bot${secret.token}/setWebhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, allowed_updates: ['message'] }),
        }).catch(() => undefined);
      } catch {
        /* best-effort: не мешаем публикации */
      }
    }
  }

  // ---------------------------------------------------------------
  // Ф3: сейф кредов (CRUD; секрет наружу не отдаётся)
  // ---------------------------------------------------------------

  async listCredentials(userId: string, workspaceId: string) {
    await this.assertManage(userId, workspaceId);
    const creds = await this.db.processCredential.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return creds.map((c) => ({ id: c.id, name: c.name, type: c.type as 'header' | 'basic' | 'bearer', createdAt: c.createdAt.toISOString() }));
  }

  async createCredential(
    userId: string,
    workspaceId: string,
    data: { name: string; type: 'header' | 'basic' | 'bearer'; token?: string; username?: string; password?: string; headerName?: string; headerValue?: string },
  ): Promise<{ id: string }> {
    await this.assertManage(userId, workspaceId);
    const secret: Record<string, string> =
      data.type === 'bearer'
        ? { token: data.token! }
        : data.type === 'basic'
          ? { username: data.username!, password: data.password! }
          : { headerName: data.headerName!, headerValue: data.headerValue! };
    const cred = await this.db.processCredential.create({
      data: { workspaceId, name: data.name, type: data.type, data: encryptSecret(JSON.stringify(secret)), createdById: userId },
    });
    return { id: cred.id };
  }

  async deleteCredential(userId: string, workspaceId: string, credentialId: string): Promise<void> {
    await this.assertManage(userId, workspaceId);
    await this.db.processCredential.deleteMany({ where: { id: credentialId, workspaceId } });
  }

  // ---------------------------------------------------------------
  // Ф2: claim очереди отдела · решение по одобрению · инбокс · отчёт
  // ---------------------------------------------------------------

  /** Забрать задачу отдела из очереди → создаётся задача исполнителю; возвращает её id. */
  async claimStep(userId: string, workspaceId: string, instanceId: string, stepId: string): Promise<{ taskId: string }> {
    await this.assertTeamMember(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId }, select: { workspaceId: true } });
    if (!instance || instance.workspaceId !== workspaceId) throw new NotFoundException('Процесс не найден');
    const taskId = await this.engine.claimQueueStep(userId, instanceId, stepId);
    return { taskId };
  }

  /** Вынести решение по одобрению (назначенный согласующий). */
  async decideStep(userId: string, workspaceId: string, instanceId: string, stepId: string, decision: 'approved' | 'rejected'): Promise<void> {
    await this.assertTeamMember(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId }, select: { workspaceId: true } });
    if (!instance || instance.workspaceId !== workspaceId) throw new NotFoundException('Процесс не найден');
    await this.engine.decideApproval(userId, instanceId, stepId, decision);
  }

  /** Ф2.5: переназначить исполнителя шага (manager+). */
  async reassignStep(userId: string, workspaceId: string, instanceId: string, stepId: string, newUserId: string): Promise<void> {
    await this.assertManage(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId }, select: { workspaceId: true } });
    if (!instance || instance.workspaceId !== workspaceId) throw new NotFoundException('Процесс не найден');
    await this.engine.reassignStep(instanceId, stepId, newUserId);
  }

  /** «Входящие»: задачи моих отделов в очереди (забрать) + одобрения на мне. */
  async listInbox(userId: string, workspaceId: string): Promise<import('@superapp/shared').ProcessInboxItem[]> {
    await this.assertTeamMember(userId, workspaceId);
    const myDeptTuples = await this.db.relationTuple.findMany({
      where: { resourceType: 'department', relation: 'member', subjectType: 'user', subjectId: userId },
      select: { resourceId: true },
    });
    const myDeptIds = [...new Set(myDeptTuples.map((t) => t.resourceId))];

    const steps = await this.db.processStepRun.findMany({
      where: {
        status: 'active',
        instance: { workspaceId, status: 'running' },
        OR: [
          // claimable задачи моих отделов
          myDeptIds.length ? { departmentId: { in: myDeptIds }, taskId: null } : { id: '__none__' },
          // одобрения на мне
          { nodeType: 'human.approval', assigneeId: userId, decision: null },
        ],
      },
      orderBy: { startedAt: 'asc' },
      take: 100,
      include: {
        instance: { select: { id: true, startedById: true, definition: { select: { name: true } } } },
      },
    });

    const deptIds = [...new Set(steps.map((s) => s.departmentId).filter((x): x is string => !!x))];
    const deptNames = new Map<string, string>();
    if (deptIds.length) {
      const deps = await this.db.staffDepartment.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } });
      for (const d of deps) deptNames.set(d.id, d.name);
    }
    const starters = await this.userMinis([...new Set(steps.map((s) => s.instance.startedById))]);
    const now = Date.now();

    return steps.map((s) => {
      const spec = (s.output ?? {}) as { title?: string; description?: string | null };
      const isClaim = !!s.departmentId && !s.taskId;
      return {
        kind: isClaim ? 'claim' : 'approve',
        instanceId: s.instance.id,
        stepId: s.id,
        processName: s.instance.definition.name,
        title: spec.title || s.nodeType,
        detail: spec.description ?? null,
        departmentName: s.departmentId ? (deptNames.get(s.departmentId) ?? null) : null,
        startedBy: starters.get(s.instance.startedById) ?? { id: s.instance.startedById, firstName: '—', lastName: null },
        createdAt: s.startedAt.toISOString(),
        deadlineAt: s.deadlineAt?.toISOString() ?? null,
        overdue: !!s.deadlineAt && s.deadlineAt.getTime() <= now,
      };
    });
  }

  /** Отчёт «время по шагам/отделам» — агрегаты завершённых шагов процесса. */
  async getReport(userId: string, workspaceId: string, definitionId: string): Promise<import('@superapp/shared').ProcessReportDto> {
    const role = await this.assertManage(userId, workspaceId);
    const def = await this.loadDefinition(workspaceId, definitionId);
    this.assertDefVisible(role, def);

    // Подписи нод — из последней версии; агрегация длительностей — в SQL (P5), а не
    // перекачивая до 10k строк в JS. Длительность = completed_at − started_at (мс).
    const latest = await this.latestVersion(definitionId);
    const doc = latest.document as unknown as ProcessDocument;
    const labels = new Map(doc.nodes.map((n) => [n.id, n.label || n.type]));

    type AggRow = { node_id: string; node_type: string; department_id: string | null; cnt: bigint; avg_ms: number | null; max_ms: number | null; total_ms: number | null };
    const agg = await this.db.$queryRaw<AggRow[]>`
      SELECT sr.node_id,
             MAX(sr.node_type) AS node_type,
             MAX(sr.department_id) AS department_id,
             COUNT(*) AS cnt,
             AVG(EXTRACT(EPOCH FROM (sr.completed_at - sr.started_at)) * 1000) AS avg_ms,
             MAX(EXTRACT(EPOCH FROM (sr.completed_at - sr.started_at)) * 1000) AS max_ms,
             SUM(EXTRACT(EPOCH FROM (sr.completed_at - sr.started_at)) * 1000) AS total_ms
      FROM process_step_runs sr
      JOIN process_instances pi ON pi.id = sr.instance_id
      WHERE pi.definition_id = ${definitionId} AND sr.status = 'done' AND sr.completed_at IS NOT NULL
      GROUP BY sr.node_id`;

    const deptIds = [...new Set(agg.map((r) => r.department_id).filter((x): x is string => !!x))];
    const deptNames = new Map<string, string>();
    if (deptIds.length) {
      const deps = await this.db.staffDepartment.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } });
      for (const d of deps) deptNames.set(d.id, d.name);
    }

    const rows = agg
      .map((r) => ({
        nodeId: r.node_id,
        label: labels.get(r.node_id) ?? r.node_id,
        nodeType: r.node_type,
        departmentName: r.department_id ? (deptNames.get(r.department_id) ?? null) : null,
        count: Number(r.cnt),
        avgMs: Math.round(r.avg_ms ?? 0),
        maxMs: Math.round(r.max_ms ?? 0),
        totalMs: Math.round(r.total_ms ?? 0),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    type CycleRow = { cnt: bigint; avg_ms: number | null };
    const [cycle] = await this.db.$queryRaw<CycleRow[]>`
      SELECT COUNT(*) AS cnt, AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) AS avg_ms
      FROM process_instances
      WHERE definition_id = ${definitionId} AND status = 'done' AND finished_at IS NOT NULL`;
    const finishedInstances = Number(cycle?.cnt ?? 0);
    const avgCycleMs = cycle?.avg_ms != null ? Math.round(cycle.avg_ms) : null;

    return { definitionId, definitionName: def.name, finishedInstances, avgCycleMs, rows };
  }

  // ---------------------------------------------------------------
  // Внутреннее
  // ---------------------------------------------------------------

  private async loadDefinition(workspaceId: string, definitionId: string) {
    const def = await this.db.processDefinition.findUnique({ where: { id: definitionId } });
    if (!def || def.workspaceId !== workspaceId || def.status === 'archived') {
      throw new NotFoundException('Процесс не найден');
    }
    return def;
  }

  private async latestVersion(definitionId: string) {
    const latest = await this.db.processVersion.findFirst({
      where: { definitionId },
      orderBy: { version: 'desc' },
    });
    if (!latest) throw new NotFoundException('У процесса нет версий');
    return latest;
  }

  /** Исполнители/получатели нод — действующие члены команды организации (не Подрядчик). */
  private async validateMembers(
    workspaceId: string,
    document: ProcessDocument,
  ): Promise<ProcessValidationIssue[]> {
    const wanted = new Map<string, string>(); // userId → nodeId
    for (const n of document.nodes) {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const id =
        (n.type === 'human.task' && cfg.assigneeMode === 'member' && cfg.assigneeUserId) ||
        (n.type === 'notify' && cfg.to === 'member' && cfg.userId) ||
        // авто-триггеры идут «от имени» сотрудника — он должен работать в организации
        (TRIGGER_NODE_TYPE[n.type] && cfg.runAsUserId);
      if (typeof id === 'string' && id) wanted.set(id, n.id);
    }
    if (wanted.size === 0) return [];
    const rows = await this.db.userRole.findMany({
      where: {
        context: WS_CONTEXT,
        tenantId: workspaceId,
        userId: { in: [...wanted.keys()] },
        isActive: true,
        role: { not: 'contractor' },
      },
      select: { userId: true },
    });
    const members = new Set(rows.map((r) => r.userId));
    const issues: ProcessValidationIssue[] = [];
    for (const [userId, nodeId] of wanted) {
      if (!members.has(userId)) {
        issues.push({ nodeId, message: 'Выбранный человек не является сотрудником организации' });
      }
    }
    return issues;
  }

  /** Анкета при запуске: обязательность + типизация (number/boolean/date/select). */
  private validateFormInput(
    form: ProcessFormField[],
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const errors: { field: string; message: string }[] = [];
    const values: Record<string, unknown> = {};
    for (const f of form) {
      const raw = input[f.key];
      const empty = raw === null || raw === undefined || raw === '';
      if (empty) {
        if (f.required) errors.push({ field: f.key, message: `«${f.label}» обязательно` });
        continue;
      }
      // Только примитивы: массив/объект в Number()/String() дают тихий мусор ([]→0, {}→'[object Object]').
      if (typeof raw === 'object') {
        errors.push({ field: f.key, message: `«${f.label}»: недопустимое значение` });
        continue;
      }
      switch (f.type) {
        case 'number': {
          const num = Number(raw);
          if (Number.isNaN(num)) errors.push({ field: f.key, message: `«${f.label}» — число` });
          else values[f.key] = num;
          break;
        }
        case 'boolean':
          values[f.key] = raw === true || raw === 'true' || raw === 'да';
          break;
        case 'date': {
          const d = new Date(String(raw));
          if (Number.isNaN(d.getTime()))
            errors.push({ field: f.key, message: `«${f.label}» — дата` });
          else values[f.key] = d.toISOString().slice(0, 10);
          break;
        }
        case 'select': {
          const v = String(raw);
          if (!f.options?.includes(v))
            errors.push({ field: f.key, message: `«${f.label}»: недопустимый вариант` });
          else values[f.key] = v;
          break;
        }
        default: {
          const s = String(raw);
          if (s.length > 500) errors.push({ field: f.key, message: `«${f.label}» слишком длинное` });
          else if (/[<>]/.test(s))
            errors.push({ field: f.key, message: `«${f.label}»: недопустимые символы` });
          else values[f.key] = s;
        }
      }
    }
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Проверьте анкету процесса', errors });
    }
    return values;
  }

  private async userMinis(ids: string[]): Promise<Map<string, ProcessUserMini>> {
    if (ids.length === 0) return new Map();
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, { id: u.id, firstName: u.firstName, lastName: u.lastName }]));
  }

  private toDefinitionDto(
    def: {
      id: string;
      workspaceId: string;
      name: string;
      description: string | null;
      visibility: string;
      status: string;
      currentVersionId: string | null;
      createdAt: Date;
      updatedAt: Date;
      versions: { version: number; status: string }[];
    },
    runningCount: number,
  ): ProcessDefinitionDto {
    const latest = def.versions[0];
    return {
      id: def.id,
      workspaceId: def.workspaceId,
      name: def.name,
      description: def.description,
      visibility: def.visibility as ProcessDefinitionDto['visibility'],
      status: def.status as ProcessDefinitionDto['status'],
      hasPublished: !!def.currentVersionId,
      publishedVersion: null, // заполняется в detail
      latestVersion: latest?.version ?? 1,
      latestVersionStatus: (latest?.status ?? 'draft') as ProcessDefinitionDto['latestVersionStatus'],
      runningCount,
      createdAt: def.createdAt.toISOString(),
      updatedAt: def.updatedAt.toISOString(),
    };
  }

  private toInstanceDto(
    instance: {
      id: string;
      definitionId: string;
      workspaceId: string;
      status: string;
      error: string | null;
      startedById: string;
      startedAt: Date;
      finishedAt: Date | null;
      definition: { name: string };
      version: { version: number };
    },
    users: Map<string, ProcessUserMini>,
    currentSteps: string[],
  ): ProcessInstanceDto {
    return {
      id: instance.id,
      definitionId: instance.definitionId,
      definitionName: instance.definition.name,
      version: instance.version.version,
      workspaceId: instance.workspaceId,
      status: instance.status as ProcessInstanceDto['status'],
      error: instance.error,
      startedBy:
        users.get(instance.startedById) ??
        ({ id: instance.startedById, firstName: '—', lastName: null } as ProcessUserMini),
      startedAt: instance.startedAt.toISOString(),
      finishedAt: instance.finishedAt?.toISOString() ?? null,
      durationMs: instance.finishedAt
        ? instance.finishedAt.getTime() - instance.startedAt.getTime()
        : null,
      currentSteps,
    };
  }
}
