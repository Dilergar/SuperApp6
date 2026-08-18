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
  SURFACE_NODE_TYPES,
  TEAM_WORKSPACE_ROLES,
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
  type ProcessCredentialDto,
  type ProcessSurface,
} from '@superapp/shared';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { encryptSecret, decryptSecret } from './process-crypto';
import { ProcessNodeRegistry } from './process-node.registry';
import { ProcessEngineService } from './process-engine.service';
import { compileProcessDocument } from './process-compiler';
import { BUILTIN_PROCESS_NODES, PROCESS_ORIGIN_TYPE } from './process-builtin-nodes';
import { checkSurfaceRules } from './process-document-rules';
import { ApprovalsService } from '../../core/approvals/approvals.service';
import { SERVICE_PROCESS_NODES, fetchJson } from './process-service-nodes';
import { AI_PROCESS_NODES } from './process-ai-nodes';
import { KZ_PROCESS_NODES } from './process-kz-nodes';
import { ACTION_PROCESS_NODES } from './process-action-nodes';
import { DOCUMENT_PROCESS_NODES } from './process-document-nodes';
import type { CompiledPlan } from './process-node.types';

const WS_CONTEXT = 'workspace';

/**
 * Поля шага для карточки/статуса инстанса — БЕЗ тяжёлого `output` (AI/HTTP-блобы) (P7):
 * getInstance и тонкий статус-эндпоинт тянут только нужное, не мегабайты на автообновлении.
 */
const INSTANCE_STEP_SELECT = {
  id: true,
  // Нужен, чтобы собрать ключ `инстанс:шаг`, по которому движок согласований
  // находит заявку этого шага (адресность живёт там, а не в assigneeId).
  instanceId: true,
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
const TRIGGER_NODE_TYPE: Record<string, 'schedule' | 'webhook' | 'event' | 'telegram' | 'document'> = {
  'trigger.schedule': 'schedule',
  'trigger.webhook': 'webhook',
  'trigger.event': 'event',
  'trigger.telegram': 'telegram',
  // Отправка документа на маршрут. Стартует не шина и не расписание, а сервис
  // «Документы» — он же ищет строку триггера по своему templateId.
  'trigger.document': 'document',
};

// --- Санитайзер переменных ВНЕШНЕГО старта (публичный вебхук / приёмник Telegram) ---
/** Служебные ключи движка в variables (_item, _subprocessDepth, _loopIdx_*) — только изнутри. */
const ENGINE_RESERVED_PREFIX = '_';
/** Адресат ответа Telegram: приходит от Telegram-триггера, а не из чужого вебхука. */
const TELEGRAM_OWNED_KEYS = new Set(['chatId', 'fromId', 'messageId']);
const EXT_MAX_DECLARED_LEN = 500; // как в анкете интерактивного запуска
const EXT_MAX_FREE_LEN = 4096; // нераспознанный ключ: потолок сообщения Telegram
const EXT_MAX_KEYS = 100;
const EXT_MAX_DEPTH = 5;
const EXT_MAX_ARRAY = 200;
/** Телеграмный chat id: число или @username. */
const TELEGRAM_CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

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
    private approvals: ApprovalsService,
    private chatter: ChatterService,
  ) {}

  onModuleInit(): void {
    for (const provider of [
      ...BUILTIN_PROCESS_NODES,
      ...SERVICE_PROCESS_NODES,
      ...AI_PROCESS_NODES,
      ...KZ_PROCESS_NODES,
      ...ACTION_PROCESS_NODES,
      ...DOCUMENT_PROCESS_NODES,
    ]) {
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
    // БЕЛЫЙ список командных ролей (Стажёр+), а не «всё, кроме Подрядчика»: fail-closed —
    // новая роль лестницы по чёрному списку молча получила бы чтение и ЗАПУСК процессов.
    // Ранговые гейты выше (assertManage — Менеджер+) считаются рангами и не затронуты.
    if (!(TEAM_WORKSPACE_ROLES as readonly string[]).includes(role)) {
      // Персональная формулировка — только Подрядчику (единственная существующая
      // не-командная роль); любая будущая получает нейтральный отказ, а не проход.
      throw new ForbiddenException(
        role === 'contractor'
          ? 'Подрядчику доступны только его задачи'
          : 'Нет доступа к этой организации',
      );
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

  /**
   * Палитра нод. `surface` режет её под предметную область: кадровик, рисующий
   * маршрут документа, не должен видеть ноды про счета, HTTP и AI-агентов — иначе
   * «урезанный редактор» перестаёт быть урезанным уже на третьем релизе.
   * Нода без `surfaces` видна везде (общий канвас Процессов).
   */
  async listNodeTypes(
    userId: string,
    workspaceId: string,
    surface?: ProcessSurface,
  ): Promise<ProcessNodeTypeDto[]> {
    await this.assertTeamMember(userId, workspaceId);
    const includeSystem = await this.isPlatformAdmin(userId);
    const all = this.registry.listTypes(includeSystem);
    // Нода могла объявить себя специальной («видна только в документных профилях») —
    // такие не засоряют общий канвас.
    const visible = all.filter((t) => !t.surfaces || t.surfaces.includes(surface ?? 'general'));
    if (!surface || surface === 'general') return visible;
    // Урезанный профиль — БЕЛЫЙ список: новая нода платформы не появляется у кадровика
    // сама собой, её туда добавляют осознанно.
    const allowed = SURFACE_NODE_TYPES[surface];
    return allowed ? visible.filter((t) => allowed.includes(t.type)) : visible;
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

  /**
   * Создать процесс. `surface` — профиль редактора: он режет палитру нод и включает
   * правила предметной области. `document` — готовая заготовка канваса: сервис
   * «Документы» заводит маршрут не пустым, а сразу собранным под шаблон (человеку
   * остаётся указать, кто подписывает) — пустой холст на 32 ноды кадровика отпугивает.
   */
  async createDefinition(
    userId: string,
    workspaceId: string,
    data: {
      name: string;
      description?: string | null;
      surface?: string;
      document?: ProcessDocument;
    },
  ): Promise<ProcessDefinitionDetailDto> {
    await this.assertManage(userId, workspaceId);
    const def = await this.db.$transaction(async (tx) => {
      const created = await tx.processDefinition.create({
        data: {
          workspaceId,
          name: data.name,
          description: data.description ?? null,
          ...(data.surface ? { surface: data.surface } : {}),
          createdById: userId,
        },
      });
      await tx.processVersion.create({
        data: {
          definitionId: created.id,
          version: 1,
          status: 'draft',
          document: (data.document ?? DEFAULT_DOCUMENT) as unknown as object,
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
    // Правила профиля показываем прямо в карточке процесса — кадровик видит, чего
    // не хватает по ТК РК, ещё до попытки публикации.
    issues.push(...checkSurfaceRules(def.surface, document));
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
    // Вычисляем ДО сборки триггеров: URL вебхука несёт секретный токен и отдаётся
    // только тем, кто и так может править процесс.
    const canEdit = (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
    const triggers = triggerRows.map((t) => {
      const cfg = (t.config ?? {}) as { nodeId?: string };
      // Telegram-вебхук слушается на отдельном пути (там разбирается Telegram-апдейт).
      const webhookPath = t.type === 'telegram' ? 'webhook/telegram' : 'webhook';
      return {
        nodeId: cfg.nodeId ?? '',
        type: t.type as 'schedule' | 'webhook' | 'event' | 'telegram',
        enabled: t.enabled,
        // Чтение определения открыто всей команде (assertTeamMember, стажёр+), а токен —
        // это ключ к публичному эндпоинту, который стартует процесс ОТ ИМЕНИ сотрудника
        // из runAsUserId. Раньше его видел любой стажёр.
        webhookUrl:
          canEdit && t.webhookToken ? `${base}/api/processes/${webhookPath}/${t.webhookToken}` : null,
        nextRunAt: t.nextRunAt?.toISOString() ?? null,
        lastRunAt: t.lastRunAt?.toISOString() ?? null,
      };
    });

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
      surface: def.surface,
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
    const def = await this.loadDefinition(workspaceId, definitionId);
    issues.push(...checkSurfaceRules(def.surface, document));
    return { version: saved, issues };
  }

  async validateDefinition(
    userId: string,
    workspaceId: string,
    definitionId: string,
  ): Promise<{ issues: ProcessValidationIssue[] }> {
    const role = await this.assertTeamMember(userId, workspaceId);
    const def = await this.loadDefinition(workspaceId, definitionId);
    this.assertDefVisible(role, def);
    const latest = await this.latestVersion(definitionId);
    const { issues } = compileProcessDocument(
      latest.document as unknown as ProcessDocument,
      this.registry,
    );
    // Правила предметной области (ТК РК у кадровых маршрутов) — предупреждения:
    // публикацию не блокируют, но требуют явного «Понимаю, публикую».
    issues.push(...checkSurfaceRules(def.surface, latest.document as unknown as ProcessDocument));
    // Правило «от имени» показываем только тем, кто МОЖЕТ публиковать. Стажёру,
    // открывшему чужой процесс, ошибка про чужой ранг бесполезна, а её наличие/отсутствие
    // работало бы оракулом ролей коллег на read-only эндпоинте.
    const rank = WORKSPACE_ROLE_RANK[role] ?? 0;
    const memberIssues = await this.validateMembers(
      workspaceId,
      latest.document as unknown as ProcessDocument,
      rank >= WORKSPACE_ROLE_RANK.manager ? rank : null,
    );
    return { issues: [...issues, ...memberIssues] };
  }

  /** Публикация: компиляция без ошибок + исполнители — действующие члены команды. */
  async publish(
    userId: string,
    workspaceId: string,
    definitionId: string,
    acceptWarnings: string[] = [],
  ): Promise<ProcessDefinitionDetailDto> {
    const role = await this.assertManage(userId, workspaceId);
    const def = await this.loadDefinition(workspaceId, definitionId);
    this.assertDefVisible(role, def);
    const latest = await this.latestVersion(definitionId);
    if (latest.status !== 'draft') {
      throw new BadRequestException('Нет черновика для публикации — внесите изменения');
    }
    const document = latest.document as unknown as ProcessDocument;
    const { plan, issues } = compileProcessDocument(document, this.registry);
    const actorRank = WORKSPACE_ROLE_RANK[role] ?? 0;
    const memberIssues = await this.validateMembers(workspaceId, document, actorRank);
    const ruleIssues = checkSurfaceRules(def.surface, document);
    const routeIssues = await this.validateDocumentTriggers(workspaceId, definitionId, document);
    const all = [...issues, ...memberIssues, ...ruleIssues, ...routeIssues];

    // Отсутствие severity читается как 'error' (fail-closed): забытый вызов и старые
    // сохранённые issues остаются блокирующими, а не проскакивают предупреждением.
    const errors = all.filter((i) => (i.severity ?? 'error') === 'error');
    if (!plan || errors.length > 0) {
      throw new BadRequestException({
        message: 'Процесс не готов к публикации',
        errors: errors.map((i) => ({ field: i.nodeId ?? i.edgeId ?? 'document', message: i.message })),
      });
    }

    // Предупреждения предметной области принимаются ПОИМЁННО: «Понимаю, публикую»
    // на одно правило не должно молча накрывать все остальные, в том числе те,
    // которые появятся в следующем релизе закона.
    const warnings = all.filter((i) => i.severity === 'warning');
    const unaccepted = warnings.filter((w) => !w.ruleKey || !acceptWarnings.includes(w.ruleKey));
    if (unaccepted.length > 0) {
      throw new BadRequestException({
        message: 'Маршрут нарушает правила кадрового учёта — подтвердите публикацию',
        details: { code: 'process_warnings_unaccepted', warnings: unaccepted.map((w) => ({ ruleKey: w.ruleKey, message: w.message })) },
        errors: unaccepted.map((w) => ({ field: w.ruleKey ?? 'document', message: w.message })),
      });
    }

    // Кто взял риск — знаем ДО транзакции: имя снимком, как везде в хронике
    // (запись обязана пережить удаление аккаунта автора).
    const actorName = warnings.length > 0 ? await this.displayName(userId) : null;

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
      // actorRank запоминается в строке: роли меняются, а триггер живёт дальше.
      await this.syncTriggersOnPublish(tx, definitionId, workspaceId, document, userId, actorRank);

      // «Понимаю, публикую» — в «Журнал организации», СИНХРОННО в той же
      // транзакции (правило движка хроники). Предупреждения не блокируют
      // публикацию, поэтому единственный след принятого риска — эта запись:
      // без неё через полгода нечем ответить на вопрос, кто и когда решил
      // выпустить маршрут без ознакомления сотрудника.
      if (warnings.length > 0) {
        await this.chatter.log(tx, {
          // Хроника ОРГАНИЗАЦИИ (её резолвер видимости — Менеджер+), а не процесса:
          // строка попадает в «Журнал организации», где её и будут искать.
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId: userId,
          actorName,
          typeKey: 'process.published_with_warnings',
          payload: {
            processName: def.name,
            ruleList: warnings.map((w) => w.message).join('; '),
            ruleKeys: warnings.map((w) => w.ruleKey).filter(Boolean),
          },
        });
      }
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
    await this.db.$transaction(async (tx) => {
      await tx.processDefinition.update({ where: { id: definitionId }, data: { status: 'archived' } });
      // Триггеры архивного процесса гасим. Иначе строка остаётся включённой: шаблон
      // документа продолжает считаться «с маршрутом», запуск по нему молча не
      // происходит, а НОВЫЙ маршрут на тот же шаблон не опубликовать — валидация
      // ссылается на процесс, которого в списке уже нет и снять с публикации нечем.
      await tx.processTrigger.updateMany({ where: { definitionId }, data: { enabled: false } });
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

    // Кому шаг-решение адресован СЕЙЧАС, спрашиваем у движка согласований — там снимок,
    // и он единственная правда об адресности. Одним запросом на весь инстанс, а не по
    // шагу: адресатом бывает должность или отдел, и `assigneeId` шага их не выражает.
    const decidableStepIds = new Set<string>();
    const pendingApproval = steps.filter((s) => s.status === 'active' && s.nodeType === 'human.approval');
    if (pendingApproval.length) {
      const rows = await this.db.approvalRequest.findMany({
        where: {
          originType: PROCESS_ORIGIN_TYPE,
          originRef: { in: pendingApproval.map((s) => `${s.instanceId}:${s.id}`) },
          status: 'pending',
        },
        select: { originRef: true, steps: { where: { status: 'active' }, select: { awaitingUserIds: true, decisions: { where: { userId }, select: { id: true } } } } },
      });
      for (const r of rows) {
        const decidable = r.steps.some((st) => st.awaitingUserIds.includes(userId) && st.decisions.length === 0);
        if (decidable && r.originRef) decidableStepIds.add(r.originRef.slice(r.originRef.indexOf(':') + 1));
      }
    }

    return { users, deptNames, viewerDepts, decidableStepIds };
  }

  /** Снимок шагов инстанса → DTO (подпись из label-снимка; overdue/canClaim/canDecide/canReassign). */
  private mapSteps(
    steps: InstanceStepRow[],
    ctx: { users: Map<string, ProcessUserMini>; deptNames: Map<string, string>; viewerDepts: Set<string>; decidableStepIds: Set<string>; managerAllowed: boolean; userId: string; now: number },
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
        canDecide: ctx.decidableStepIds.has(s.id),
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

  /**
   * Остановить маршрут ПРОГРАММНО — зовёт сервис-владелец предмета (Документы, когда
   * автор отменил документ). Гейты сервиса Процессов здесь не применяются намеренно:
   * право на отмену уже проверил владелец предмета по своим правилам, а маршрут без
   * предмета продолжать бессмысленно.
   */
  async cancelInstanceProgrammatic(instanceId: string, byUserId: string): Promise<boolean> {
    return this.engine.cancelInstance(instanceId, byUserId);
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

    // ВНЕШНИЙ источник (публичный вебхук / приёмник Telegram) — тело чужое, санитайзим.
    // Внутренние (событие платформы, расписание, под-процесс) идут прежним ленивым путём:
    // их payload собран нашим же кодом, а под-процесс ОБЯЗАН пронести служебный
    // _subprocessDepth, который санитайзер отбрасывает.
    const variables =
      triggerType === 'webhook' || triggerType === 'telegram'
        ? this.sanitizeExternalVariables(plan.form, rawVariables, triggerType)
        : this.coerceLenientVariables(plan.form, rawVariables);

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
    /**
     * Ранг публикатора на момент публикации — потолок для «от имени» при СРАБАТЫВАНИИ.
     * Роли меняются, а строка триггера живёт: без этого опубликованный законно
     * runAs = сотрудник, которого потом повысили до владельца, стрелял бы правами
     * владельца. Хранится в config (JSON) — миграция не нужна.
     */
    publisherRank: number,
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
        const config = { nodeId: n.id, everyValue, everyUnit, publisherRank };
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
          publisherRank,
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
      } else if (type === 'document') {
        // Связь «шаблон → маршрут» живёт здесь: сервис «Документы» при отправке ищет
        // строку по (workspaceId, type='document', templateId). Стабильного токена и
        // расписания у неё нет — старт всегда изнутри платформы.
        const config = { nodeId: n.id, templateId: String(cfg.templateId ?? ''), publisherRank };
        if (prev) {
          await tx.processTrigger.update({ where: { id: prev.id }, data: { type, config, runAsUserId, enabled: true } });
        } else {
          await tx.processTrigger.create({
            data: { definitionId, workspaceId, type, config, runAsUserId, enabled: true, createdById: publishedById },
          });
        }
      } else if (type === 'webhook') {
        // webhook — токен стабилен между публикациями (внешний URL не должен «протухать»).
        const config = { nodeId: n.id, publisherRank };
        if (prev) {
          await tx.processTrigger.update({ where: { id: prev.id }, data: { type, config, runAsUserId, enabled: true } });
        } else {
          await tx.processTrigger.create({
            data: { definitionId, workspaceId, type, config, runAsUserId, enabled: true, webhookToken: randomBytes(24).toString('base64url'), createdById: publishedById },
          });
        }
      } else {
        // telegram — вебхук бота: токен пути стабилен; credentialId (токен @BotFather) в config.
        const config = { nodeId: n.id, credentialId: String(cfg.credentialId ?? ''), publisherRank };
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
   * «Один шаблон — один маршрут» (решение грилла). Проверяем при ПУБЛИКАЦИИ, а не при
   * рисовании: черновиков может быть сколько угодно, а вот два живых маршрута на один
   * шаблон сделали бы запуск недетерминированным — сервис «Документы» ищет строку
   * триггера по templateId и не может выбирать между двумя.
   */
  private async validateDocumentTriggers(
    workspaceId: string,
    definitionId: string,
    document: ProcessDocument,
  ): Promise<ProcessValidationIssue[]> {
    const wanted = document.nodes
      .filter((n) => n.type === 'trigger.document')
      .map((n) => String(((n.config ?? {}) as { templateId?: string }).templateId ?? ''))
      .filter(Boolean);
    // Ноды «Сформировать документ» проверяются НАРАВНЕ с триггерами: раннего выхода
    // по пустым триггерам здесь быть не может — маршрут без trigger.document всё ещё
    // способен породить документ нодой doc.generate.
    const generateNodes = document.nodes
      .filter((n) => n.type === 'doc.generate')
      .map((n) => ({
        nodeId: n.id,
        templateId: String(((n.config ?? {}) as { templateId?: string }).templateId ?? ''),
      }))
      .filter((n) => n.templateId);
    if (!wanted.length && !generateNodes.length) return [];

    const issues: ProcessValidationIssue[] = [];
    const dup = wanted.filter((id, i) => wanted.indexOf(id) !== i);
    for (const id of new Set(dup)) {
      issues.push({
        severity: 'error',
        message: 'Два триггера на один и тот же шаблон в одном маршруте — оставьте один',
        nodeId: undefined,
      });
    }

    // Виды «С контрагентами» по маршрутам v1 не ходят: их путь прямой (черновик →
    // «Отправить контрагенту»), submit для них отвечает 400 — то есть нарисованный
    // маршрут было бы нечем запустить, и он лишь обещал бы то, чего не случится.
    const allTemplateIds = [...new Set([...wanted, ...generateNodes.map((n) => n.templateId)])];
    const externalTpls = await this.db.docTemplate.findMany({
      where: { id: { in: allTemplateIds }, docType: { category: 'external' } },
      select: { id: true, name: true },
    });
    for (const tpl of externalTpls) {
      if (wanted.includes(tpl.id)) {
        issues.push({
          severity: 'error',
          message: `Шаблон «${tpl.name}» — для документов с контрагентами: они отправляются контрагенту с карточки, а маршрут для них появится вместе с нодой отправки`,
        });
      }
      // «Сформировать документ» по external-шаблону породил бы документ в статусе
      // «На маршруте», из которого для категории «С контрагентами» нет продолжения:
      // submit его отвергает, а «Отправить контрагенту» требует черновика.
      for (const g of generateNodes.filter((n) => n.templateId === tpl.id)) {
        issues.push({
          severity: 'error',
          message: `Шаблон «${tpl.name}» — для документов с контрагентами: нода «Сформировать документ» не может создать его на маршруте — такие документы отправляются контрагенту с карточки`,
          nodeId: g.nodeId,
        });
      }
    }
    if (!wanted.length) return issues;

    const others = await this.db.processTrigger.findMany({
      where: {
        workspaceId,
        type: 'document',
        enabled: true,
        definitionId: { not: definitionId },
        // Архивный процесс маршрутом не считается и публикацию нового не блокирует.
        definition: { status: 'active' },
      },
      select: { config: true, definition: { select: { name: true } } },
    });
    for (const t of others) {
      const templateId = String(((t.config ?? {}) as { templateId?: string }).templateId ?? '');
      if (templateId && wanted.includes(templateId)) {
        issues.push({
          severity: 'error',
          message: `У этого шаблона уже есть опубликованный маршрут — «${t.definition.name}». Снимите его с публикации или выберите другой шаблон`,
        });
      }
    }
    return issues;
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
        // Скоуп по организации — как у трёх соседних загрузчиков кредов
        // (process-service-nodes:13/293, process-ai-nodes:46). Без него менеджер мог
        // указать в холсте credentialId ЧУЖОЙ организации: сервер расшифровывал её
        // токен бота и переводил вебхук этого бота на свой процесс.
        // Чокпоинт DatabaseService тут не спасает — он авто-скоупит только Task.
        if (!cred || cred.workspaceId !== t.workspaceId) continue;
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

  async listCredentials(userId: string, workspaceId: string): Promise<ProcessCredentialDto[]> {
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

  /**
   * Вынести решение с карточки запуска.
   *
   * Сама ручка осталась (кнопки на странице инстанса), но решение теперь принимает
   * ДВИЖОК СОГЛАСОВАНИЙ — здесь только перевод «шаг процесса → шаг заявки». Иначе
   * появился бы второй путь принятия решения со своими правилами адресности, и
   * права на странице запуска разошлись бы с правами в общей стопке.
   */
  async decideStep(
    userId: string,
    workspaceId: string,
    instanceId: string,
    stepId: string,
    decision: 'approved' | 'rejected' | 'returned',
    comment?: string,
  ): Promise<void> {
    await this.assertTeamMember(userId, workspaceId);
    const instance = await this.db.processInstance.findUnique({ where: { id: instanceId }, select: { workspaceId: true } });
    if (!instance || instance.workspaceId !== workspaceId) throw new NotFoundException('Процесс не найден');

    const request = await this.db.approvalRequest.findFirst({
      where: { originType: PROCESS_ORIGIN_TYPE, originRef: `${instanceId}:${stepId}`, status: 'pending' },
      select: { steps: { where: { status: 'active' }, select: { id: true }, take: 1 } },
    });
    const approvalStepId = request?.steps[0]?.id;
    if (!approvalStepId) throw new BadRequestException('Решение по этому шагу уже не требуется');

    await this.approvals.decide(userId, approvalStepId, { decision, comment });
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
        // ТОЛЬКО claimable задачи отделов. Решения (согласование/подпись/ознакомление)
        // отсюда УБРАНЫ: они живут в общей стопке «Ждут решения» движка согласований,
        // где адресатом может быть должность или отдел — `assigneeId` шага такого
        // адресата не выражает, и здесь они просто не находились бы.
        ...(myDeptIds.length ? { departmentId: { in: myDeptIds }, taskId: null } : { id: '__none__' }),
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

  /**
   * Исполнители/получатели нод — действующие члены команды организации (не Подрядчик),
   * ПЛЮС правило ранга для запуска «от имени».
   *
   * Почему ранг проверяется ТОЛЬКО у runAsUserId: назначить задачу или уведомление
   * начальнику — нормально и должно работать. А вот «от имени» одалживает его ПРАВА:
   * движок кладёт runAsUserId в ctx.startedById, и оттуда он уходит актором в
   * workspaces.role (смена ролей), staff.assignPosition, rich-cards.execute (деньги),
   * startSubprocess. Без этого правила менеджер публиковал триггер с runAsUserId
   * владельца и повышал себя до админа: updateMember видел актора-владельца и
   * пропускал гейт «Админов назначает только Владелец».
   *
   * @param actorRank ранг того, кто публикует. null = проверять только членство
   *                  (мягкая валидация чужого процесса тем, кто публиковать не может).
   */
  private async validateMembers(
    workspaceId: string,
    document: ProcessDocument,
    actorRank: number | null,
  ): Promise<ProcessValidationIssue[]> {
    const wanted = new Map<string, string>(); // userId → nodeId (членство: все ссылки на людей)
    const runAs = new Map<string, string>(); // userId → nodeId (ТОЛЬКО «от имени»)
    for (const n of document.nodes) {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const id =
        (n.type === 'human.task' && cfg.assigneeMode === 'member' && cfg.assigneeUserId) ||
        (n.type === 'notify' && cfg.to === 'member' && cfg.userId) ||
        // авто-триггеры идут «от имени» сотрудника — он должен работать в организации
        (TRIGGER_NODE_TYPE[n.type] && cfg.runAsUserId);
      if (typeof id !== 'string' || !id) continue;
      wanted.set(id, n.id);
      // Отдельная карта, а не флаг: один и тот же человек может быть и целью notify на
      // одной ноде, и runAs на другой — общая карта ключуется по userId и затёрла бы себя.
      if (TRIGGER_NODE_TYPE[n.type]) runAs.set(id, n.id);
    }
    if (wanted.size === 0) return [];
    const rows = await this.db.userRole.findMany({
      where: {
        context: WS_CONTEXT,
        tenantId: workspaceId,
        userId: { in: [...wanted.keys()] },
        isActive: true,
        // «Сотрудник организации» = БЕЛЫЙ список командных ролей: по чёрному списку
        // человек с будущей не-командной ролью прошёл бы валидацию публикации и стал
        // исполнителем шага / получателем уведомлений опубликованного процесса.
        role: { in: [...TEAM_WORKSPACE_ROLES] },
      },
      select: { userId: true, role: true },
    });
    // У человека может быть НЕСКОЛЬКО ролей в организации (@@unique[userId, role, …]):
    // «от имени» одалживает сильнейшую, поэтому сравниваем по максимальному рангу.
    const rankOf = new Map<string, number>();
    for (const r of rows) {
      const rank = WORKSPACE_ROLE_RANK[r.role as WorkspaceRole] ?? 0;
      if (rank > (rankOf.get(r.userId) ?? 0)) rankOf.set(r.userId, rank);
    }
    const issues: ProcessValidationIssue[] = [];
    for (const [userId, nodeId] of wanted) {
      if (!rankOf.has(userId)) {
        issues.push({ nodeId, message: 'Выбранный человек не является сотрудником организации' });
      }
    }
    if (actorRank === null) return issues;
    for (const [userId, nodeId] of runAs) {
      const rank = rankOf.get(userId);
      // rank === undefined → человек не в команде, сообщение об этом уже добавлено выше.
      if (rank !== undefined && rank > actorRank) {
        issues.push({
          nodeId,
          message:
            'Запускать «от имени» можно только сотрудника не выше вашей роли — ' +
            'иначе процесс одолжил бы чужие права',
        });
      }
    }
    return issues;
  }

  /**
   * Ленивая коэрсия для ДОВЕРЕННЫХ программных запусков (событие/расписание/под-процесс).
   * Дословно прежнее поведение startInstanceProgrammatic: распознанные поля приводим к
   * типу, всё остальное проносим как есть — включая служебный _subprocessDepth, на
   * котором держится защита от рекурсии под-процессов.
   */
  private coerceLenientVariables(
    form: ProcessFormField[],
    rawVariables: Record<string, unknown>,
  ): Record<string, unknown> {
    const variables: Record<string, unknown> = { ...rawVariables };
    for (const f of form) {
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
    return variables;
  }

  /**
   * Санитайзер переменных ВНЕШНЕГО старта. Отличия от анкеты интерактивного запуска
   * (validateFormInput) намеренные:
   *  - required НЕ валим и НИЧЕГО не бросаем: внешнему вызывающему некому чинить тело по
   *    400; негодное значение просто выпадает, нода получит '' и уйдёт в ветку «Ошибка»;
   *  - нераспознанные ключи СОХРАНЯЮТСЯ (очищенными) и сохраняют СТРУКТУРУ: {{form.x}} по
   *    телу вебхука — задокументированный сценарий (нода «Перебрать список» читает
   *    {{form.items}} как массив, притом что анкета у процесса пустая);
   *  - ключи движка (_*) выбрасываются на ЛЮБОЙ глубине: тело {"_subprocessDepth": -1e6}
   *    обходило защиту от рекурсии, а {"_loopIdx_x": 999} — перематывало цикл;
   *  - «телеграмные» ключи из ЧУЖОГО вебхука выбрасываются: схема из документации —
   *    «Chat ID = {{form.chatId}}», и подставленный chatId уводит бота организации в
   *    произвольный чат;
   *  - ОБЪЯВЛЕННОЕ поле держит тот же контракт, что в интерактивном запуске (500 символов,
   *    отказ на [<>]); свободный текст незадекларированного ключа только обрезается по
   *    длине — экранирование под HTML делает сам сток (escapeTelegramHtml), и делает это
   *    полнее: он видит ещё и {{steps.*}} (ответы HTTP/AI), недоступные санитайзеру.
   */
  private sanitizeExternalVariables(
    form: ProcessFormField[],
    raw: Record<string, unknown>,
    source: 'webhook' | 'telegram',
  ): Record<string, unknown> {
    const declared = new Map(form.map((f) => [f.key, f]));
    const out: Record<string, unknown> = {};
    let budget = EXT_MAX_KEYS;

    const clean = (v: unknown, depth: number): unknown => {
      if (v === null) return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        // Только длина. Угловые скобки НЕ трогаем намеренно: экранирование делает сам
        // сток (escapeTelegramHtml в kz.telegram), и он покрывает больше — через
        // {{steps.*}} туда приходят ответы HTTP/AI, которых санитайзер не видит.
        // Вырезать их ещё и здесь значило бы портить легитимный текст: сообщение
        // «5 < 10» от живого человека превратилось бы в «5  10».
        return v.slice(0, EXT_MAX_FREE_LEN);
      }
      if (depth >= EXT_MAX_DEPTH) return undefined;
      if (Array.isArray(v)) {
        const arr: unknown[] = [];
        for (const el of v.slice(0, EXT_MAX_ARRAY)) {
          const c = clean(el, depth + 1);
          if (c !== undefined) arr.push(c);
        }
        return arr;
      }
      if (typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (k.startsWith(ENGINE_RESERVED_PREFIX)) continue;
          if (budget-- <= 0) break;
          const c = clean(val, depth + 1);
          if (c !== undefined) o[k] = c;
        }
        return o;
      }
      return undefined;
    };

    for (const [key, value] of Object.entries(raw ?? {})) {
      if (key.startsWith(ENGINE_RESERVED_PREFIX)) continue;
      // Поле, ЯВНО объявленное в анкете, = осознанное согласие менеджера принять его снаружи.
      if (source === 'webhook' && TELEGRAM_OWNED_KEYS.has(key) && !declared.has(key)) continue;
      // Даже от самого приёмника Telegram chat id обязан быть формы id/@username:
      // эндпоинт публичный и защищён только токеном пути.
      if (key === 'chatId' && typeof value === 'string' && !TELEGRAM_CHAT_ID_RE.test(value)) continue;
      if (budget-- <= 0) break;

      const f = declared.get(key);
      const v =
        f && value !== null && typeof value !== 'object'
          ? this.coerceDeclared(f, value)
          : clean(value, 1);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  /** Мягкая коэрсия ОБЪЯВЛЕННОГО поля: типы как в анкете, но без required и без исключений. */
  private coerceDeclared(f: ProcessFormField, raw: unknown): unknown {
    if (raw === undefined || raw === null || raw === '') return undefined;
    switch (f.type) {
      case 'number': {
        const n = Number(raw);
        return Number.isNaN(n) ? undefined : n;
      }
      case 'boolean':
        return raw === true || raw === 'true' || raw === 'да';
      case 'date': {
        const d = new Date(String(raw));
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
      }
      case 'select': {
        const v = String(raw);
        return f.options?.includes(v) ? v : undefined;
      }
      default: {
        const s = String(raw);
        // Объявленное поле — ровно те же рамки, что в интерактивном запуске.
        return s.length > EXT_MAX_DECLARED_LEN || /[<>]/.test(s) ? undefined : s;
      }
    }
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

  /** Имя актёра снимком для хроники (то же, что userName в Организациях) */
  private async displayName(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : 'Пользователь';
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
