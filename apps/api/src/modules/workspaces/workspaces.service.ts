import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DI_TOKENS } from '../../shared/di-tokens';
import { DatabaseService } from '../../shared/database/database.service';
import { USER_CARD_SELECT, UserCardService } from '../../core/users/user-card.service';
import { VisibilityService, markShaped, type VisibilityViewer } from '../../core/visibility/visibility.service';
import { VisibilityPolicyService } from '../../core/visibility/visibility.policy.service';
import { VisibilityDiscoverabilityService } from '../../core/visibility/visibility.discoverability.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { DEFAULT_DOCUMENT_LANGUAGE } from '../../shared/i18n/document-words';
import { coerceLocale, type Locale } from '@superapp/i18n';
import { LegalEntitiesService } from './legal-entities.service';
import { RolesService } from '../../core/roles/roles.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../../core/notifications/notifications.service';
import { KeysCascadesService } from '../../core/keys/api-keys/keys.cascades.service';
import { WebhooksService } from '../../core/webhooks/webhooks.service';
import { StaffService } from '../staff/staff.service';
import { PaymentCardsService } from '../wallet/payment-cards.service';
import { FilesService } from '../../core/files/files.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { ApprovalsService } from '../../core/approvals/approvals.service';
import { EntitlementsService } from '../../core/entitlements/entitlements.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { ConsentsService } from '../../core/consents/consents.service';
import { ConsentsDocumentsService } from '../../core/consents/consents.documents.service';
import { AuditService } from '../../core/audit/audit.service';
import { SignService } from '../../core/sign/sign.service';
import { DocsService } from '../../core/docs/docs.service';
import { ShareLinksService } from '../../core/share-links/share-links.service';
import { WorkspacePurgeRegistry } from './workspace-purge.registry';
import { consentsRequired } from '../../shared/config/env.validation';
import type { ConsentSelectionInput } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { fullName, fullNameOrNull } from '../../shared/utils/user-name';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import {
  EVIDENCE_FILE_PROFILES,
  WORKSPACE_ERROR_CODES,
  WORKSPACE_LIMITS,
  WORKSPACE_ARCHIVE_WARN_DAYS,
  workspacePurgeAt,
  daysUntilPurge,
  APP_TIMEZONE,
  SOURCE_LOCALE,
  WORKSPACE_ROLE_RANK,
  WORKSPACE_HIRE_ROLE,
  REQUISITE_LIMITS,
  composeSignBasis,
  signBasisColumnsOf,
  signBasisPartsOf,
  visibleOr,
  type MemberRequisites,
  type WorkspaceRequisitesDto,
  type WorkspaceRequisitesInput,
  type CreateBankAccountInput,
  type UpdateBankAccountInput,
  type WorkspaceRole,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceInvitation,
  isHidden,
  maskLastName,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';

// Единая лестница из shared: contractor < trainee < staff < manager < admin < owner.
const ROLE_RANK = WORKSPACE_ROLE_RANK;

const WS_CONTEXT = 'workspace';

// Имя должности присоединяется к приглашению для отображения (филиалы — scalar-массив
// branchIds, их имена резолвятся отдельным запросом, см. serializeInvitations).
const INVITATION_INCLUDE = {
  position: { select: { name: true } },
} satisfies Prisma.WorkspaceInvitationInclude;

type UserNameRow = { firstName: string; lastName: string | null };

/**
 * WorkspacesService — B2B organizations + membership.
 *
 * Invariants:
 *   - A Workspace is always a business/org (B2B tenant). Personal life is the social
 *     graph (workspaceId = null), handled elsewhere.
 *   - Role/permissions are the single source of truth in UserRole
 *     (context="workspace", tenantId=workspaceId), managed via RolesService.
 *     Должности/отделы/филиалы — сущности StaffModule (назначения), не поля здесь.
 *   - Exactly one workspace role per user per workspace (enforced by setSoleWorkspaceRoleTx).
 *   - One owner per workspace (Workspace.ownerId); ownership changes only via transfer.
 *   - Membership is independent of the personal social graph (hiring ≠ friendship).
 *   - Найм ВСЕГДА в Стажёра (роль в приглашении не выбирается); Админа назначает/снимает
 *     ТОЛЬКО Владелец; «Подрядчик» (contractor) вручную не назначается — только сервисами.
 */
@Injectable()
export class WorkspacesService implements OnModuleInit {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private db: DatabaseService,
    private roles: RolesService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private staff: StaffService,
    private paymentCards: PaymentCardsService,
    private files: FilesService,
    private chatter: ChatterService,
    private chatterRegistry: ChatterRefRegistry,
    private redis: RedisService,
    private approvals: ApprovalsService,
    private legal: LegalEntitiesService,
    private moduleRef: ModuleRef,
    private i18n: I18nService,
    private entitlements: EntitlementsService,
    private analytics: AnalyticsService,
    private keysCascades: KeysCascadesService,
    private webhooks: WebhooksService,
    private consents: ConsentsService,
    private consentDocs: ConsentsDocumentsService,
    private audit: AuditService,
    private sign: SignService,
    private docs: DocsService,
    private shareLinks: ShareLinksService,
    private purgeHooks: WorkspacePurgeRegistry,
    private readonly userCards: UserCardService,
    private readonly visibility: VisibilityService,
    private readonly visibilityPolicies: VisibilityPolicyService,
    private readonly discoverability: VisibilityDiscoverabilityService,
  ) {}

  /**
   * Имя ступени пропуска в языке ИСТОЧНИКА — для снимков, которые ложатся в БД
   * (хроника, плейсхолдер уведомления). Живое слово зритель берёт из каталога.
   */
  private roleName(role: string): string {
    return this.i18n.translateFor(SOURCE_LOCALE, `common.role.workspace.${role}`);
  }

  onModuleInit(): void {
    // Хроника организации (core/chatter): HR-события чувствительны — чтение хроники
    // воркспейса закрыто тем же гейтом, что и «Журнал организации» (роль ≥ Менеджер).
    this.chatterRegistry.register('workspace', {
      canView: async (viewerId, workspaceId) => {
        const role = await this.getMyRole(viewerId, workspaceId);
        return !!role && ROLE_RANK[role] >= ROLE_RANK.manager;
      },
    });
  }

  /** Имя пользователя для снапшотов хроники (удалённый/неизвестный → «Пользователь»). */
  private async userName(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return fullNameOrNull(u);
  }

  /**
   * Каскад увольнения/выхода: снять участия человека во встречах Виртуального офиса
   * (иначе бывший сотрудник сохраняет доступ к чатам встреч). Ленивый ModuleRef-резолв —
   * OfficeModule зависит от Messenger, прямая инъекция дала бы цикл (паттерн проекта).
   */
  private async purgeOfficeParticipations(workspaceId: string, userId: string): Promise<void> {
    try {
      const office = this.moduleRef.get<{
        removeAllParticipationsForUser: (ws: string, uid: string) => Promise<void>;
      }>(DI_TOKENS.OfficeService, { strict: false });
      await office.removeAllParticipationsForUser(workspaceId, userId);
    } catch (err) {
      // error, не warn: это security-каскад увольнения (доступ к чатам встреч);
      // резолв токена дополнительно гарантирован smoke-check'ом на бутстрапе,
      // а дрейф добирает OfficeCron.reconcileOrphanParticipants.
      this.logger.error(`purgeOfficeParticipations: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ============================================================
  // Workspace CRUD
  // ============================================================

  async createWorkspace(
    userId: string,
    data: { name: string; logo?: string; consents?: ConsentSelectionInput },
    evidence: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<Workspace> {
    // Согласия пакета `workspace_creation` сверяются ДО транзакции: нет пакета — нет организации.
    // Вне production поле может отсутствовать: сервер принимает действующие версии сам и честно
    // помечает основание `dev_auto` (сиды и сьюты живут без правок; образец — VERIFY_REQUIRED).
    let selection: ConsentSelectionInput | null = data.consents ?? null;
    let autoAccepted = false;
    if (selection || consentsRequired()) {
      await this.consentDocs.assertBundleSelection('workspace_creation', selection);
    } else if (await this.consentDocs.bundleReady('workspace_creation')) {
      selection = { versionIds: await this.consents.currentBundleVersionIds('workspace_creation'), locale: this.i18n.locale, channel: 'api' };
      autoAccepted = true;
    }
    let consentsAfterCommit: (() => Promise<void>) | null = null;
    const ws = await this.db.$transaction(async (tx) => {
      // Потолок «сколько организаций во владении» — тариф человека (core/entitlements):
      // COUNT под advisory-локом в этой же транзакции, два одновременных создания
      // на пороге не проходят оба; отказ — 402 с объяснением, не 400.
      await this.entitlements.assertCanCreate(tx, { type: 'user', id: userId }, 'workspaces.maxOwned');
      const w = await tx.workspace.create({
        data: { name: data.name, logo: data.logo ?? null, ownerId: userId },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: w.id, userId },
      });
      // Owner role (single source of truth) is written in the SAME tx, so a partial
      // failure can never leave the creator locked out of their own workspace.
      await tx.userRole.create({
        data: {
          userId,
          role: 'owner',
          context: WS_CONTEXT,
          tenantId: w.id,
          grantedBy: userId,
        },
      });
      // Пробный период организации (30 дней business_pro) — один на человека: второй
      // молча не заводится (частичный уникум по trialConsumedBy), организация — free.
      await this.entitlements.startTrial(tx, { type: 'workspace', id: w.id }, { consumedBy: userId });
      // Основной объект (StaffBranch.isDefault) заводится вместе с организацией: у
      // организации ВСЕГДА ≥1 объект, назначение всегда в объекте — малый бизнес без
      // отделов получает вертикаль «объект = отдел по умолчанию» без фиктивных сущностей.
      await tx.staffBranch.create({
        data: { workspaceId: w.id, name: data.name, isDefault: true },
      });
      // Первый факт журнала организации: кто и когда её создал
      await this.audit.record(tx, { key: 'org.workspace.created', workspaceId: w.id, target: { type: 'workspace', id: w.id }, details: {} });
      // Головное юрлицо — сторона будущих договоров и владелец счетов. Заводится
      // вместе с организацией: «реквизиты организации» = его реквизиты.
      await tx.legalEntity.create({
        data: {
          workspaceId: w.id,
          name: data.name,
          isHead: true,
          // Основание подписи — структурой; слово к ней подбирается на выходе
          ...this.legal.defaultSignBasis(),
        },
      });
      // Запись приёмки — в ЭТОЙ ЖЕ транзакции: организации без принятых условий не существует
      if (selection) {
        const accepted = await this.consents.accept(tx, {
          subject: { type: 'workspace', id: w.id },
          actorUserId: userId,
          actorRole: 'org_owner',
          actorBasis: autoAccepted ? 'dev_auto' : 'workspace_owner',
          versionIds: selection.versionIds,
          locale: selection.locale,
          channel: selection.channel,
          bundleKey: 'workspace_creation',
          requireBundle: 'workspace_creation',
          evidence: { ip: evidence.ip ?? null, userAgent: evidence.userAgent ?? null },
          notify: !autoAccepted,
        });
        consentsAfterCommit = accepted.afterCommit;
      }
      await this.analytics.track(tx, 'workspaces.workspace.created', {}, { userId, workspaceId: w.id });
      return w;
    });
    await (consentsAfterCommit as (() => Promise<void>) | null)?.().catch(() => undefined);

    // The role row was written directly in the tx (bypassing RolesService), so its
    // cache wasn't busted — do it now, after commit.
    await this.roles.invalidateUserCache(userId);

    return this.serializeWorkspace(ws, 1, 'owner');
  }

  async listMyWorkspaces(userId: string): Promise<Workspace[]> {
    const allRoles = await this.roles.getUserRoles(userId);
    const wsRoles = allRoles.filter(
      (r) => r.context === WS_CONTEXT && r.tenantId,
    );
    if (wsRoles.length === 0) return [];

    // Highest role per workspace.
    const roleByWs = new Map<string, WorkspaceRole>();
    for (const r of wsRoles) {
      const role = r.role as WorkspaceRole;
      const cur = roleByWs.get(r.tenantId as string);
      if (!cur || ROLE_RANK[role] > ROLE_RANK[cur]) {
        roleByWs.set(r.tenantId as string, role);
      }
    }

    const workspaces = await this.db.workspace.findMany({
      where: { id: { in: [...roleByWs.keys()] }, isActive: true },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return this.serializeWorkspaces(workspaces.map((w) => ({ ws: w, membersCount: w._count.members, myRole: roleByWs.get(w.id) })));
  }

  async getWorkspace(userId: string, workspaceId: string): Promise<Workspace> {
    const myRole = await this.assertMember(userId, workspaceId);
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      include: { _count: { select: { members: true, tasks: true } } },
    });
    if (!ws) throw notFound('workspace.notFound');
    return this.serializeWorkspace(ws, ws._count.members, myRole, ws._count.tasks);
  }

  /**
   * Анкета глазами РОЛИ (предпросмотр «как видит сотрудник»): тот же `workspace.card`, но
   * зритель — синтетическая роль движка видимости, а не эмуляция на клиенте. Только
   * владелец/админ: предпросмотр раскрывает, КАК настроена политика.
   */
  async cardPreview(userId: string, workspaceId: string, role: WorkspaceRole): Promise<Workspace> {
    await this.assertCanManage(userId, workspaceId);
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      include: { _count: { select: { members: true, tasks: true } } },
    });
    if (!ws) throw notFound('workspace.notFound');
    return (await this.serializeWorkspaces([{ ws, membersCount: ws._count.members, myRole: role, tasksCount: ws._count.tasks }], this.visibility.roleViewer(workspaceId, role)))[0]!;
  }

  async updateWorkspace(
    userId: string,
    workspaceId: string,
    data: {
      name?: string;
      logo?: string | null;
      description?: string | null;
      industry?: string | null;
      city?: string | null;
      website?: string | null;
      contactEmail?: string | null;
      contactPhone?: string | null;
      /** Язык БУМАГ организации (умолчание для новых бланков) */
      documentLanguage?: Locale;
    },
  ): Promise<Workspace> {
    const role = await this.assertCanManage(userId, workspaceId);
    // Лого хранится ССЫЛКОЙ → при замене прибираем прежний файл (иначе копит квоту орг.)
    const prevLogo =
      data.logo !== undefined
        ? (await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { logo: true } }))?.logo
        : undefined;
    const ws = await this.db.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.logo !== undefined ? { logo: data.logo } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.industry !== undefined ? { industry: data.industry } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.website !== undefined ? { website: data.website } : {}),
        ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail } : {}),
        ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone } : {}),
        ...(data.documentLanguage !== undefined ? { documentLanguage: data.documentLanguage } : {}),
      },
      include: { _count: { select: { members: true, tasks: true } } },
    });
    if (data.logo !== undefined && prevLogo !== ws.logo) {
      await this.files
        .reapReplacedPublicFile('workspace', workspaceId, prevLogo, ws.logo)
        .catch(() => undefined);
    }
    return this.serializeWorkspace(ws, ws._count.members, role, ws._count.tasks);
  }

  // ============================================================
  // Реквизиты организации (блок «Анкеты компании»): юрформа, БИН, банк, директор
  // ============================================================

  /**
   * Реквизиты + банковские счета. Кто видит блок — правила видимости организации
   * (core/visibility, `workspace.card`, поле `requisites`; по умолчанию — вся команда:
   * реквизиты печатаются на каждом счёте). Скрыт → data: null, веб не рисует блок. IBAN —
   * строгое поле: маска последних четырёх, раскрытие по одной записи. Подрядчик отрезан
   * гейтом команды.
   */
  async getRequisites(userId: string, workspaceId: string): Promise<WorkspaceRequisitesDto | null> {
    await this.assertTeamMember(userId, workspaceId);
    await this.getWorkspaceOrThrow(workspaceId);
    const shaped = await this.visibility.shapeOne(this.visibility.viewer('api'), 'workspace.card', {
      ref: { recordId: workspaceId, subjectId: null, workspaceId },
      values: { requisites: true },
    });
    if (shaped.requisites !== true) return null;
    return this.serializeRequisites(workspaceId);
  }

  /**
   * Upsert реквизитов (admin+, как остальная анкета). Контракт полей — PATCH:
   * null очищает, отсутствие ключа сохраняет. Директор валидируется ЧЛЕНСТВОМ
   * (выбор из сотрудников, Подрядчик не подписант).
   */
  async updateRequisites(
    userId: string,
    workspaceId: string,
    dto: WorkspaceRequisitesInput,
  ): Promise<WorkspaceRequisitesDto> {
    await this.assertCanManage(userId, workspaceId);
    if (dto.directorUserId) {
      const role = await this.getMyRoleOf(dto.directorUserId, workspaceId);
      if (!role || role === 'contractor') {
        throw badRequest('workspace.directorNotMember');
      }
    }

    const data: Prisma.LegalEntityUncheckedUpdateInput = {};
    for (const key of [
      'orgForm',
      'taxRegime',
      'legalName',
      'bin',
      'legalAddress',
      'kbe',
      'vatSeries',
      'vatNumber',
      'directorUserId',
    ] as const) {
      if (dto[key] !== undefined) data[key] = dto[key];
    }
    if (dto.vatPayer !== undefined) data.vatPayer = dto.vatPayer;
    if (dto.vatDate !== undefined) data.vatDate = dto.vatDate;
    // Основание подписи хранится структурой (см. LegalEntitiesService)
    if (dto.signBasis !== undefined) Object.assign(data, signBasisColumnsOf(dto.signBasis));

    // Старая ручка правит ГОЛОВНОЕ юрлицо — прочие редактируются через /legal-entities.
    const head = await this.legal.ensureHeadLegalEntity(workspaceId);
    await this.db.legalEntity.update({ where: { id: head.id }, data });
    return (await this.serializeRequisites(workspaceId)) as WorkspaceRequisitesDto;
  }

  async addBankAccount(
    userId: string,
    workspaceId: string,
    dto: CreateBankAccountInput,
  ): Promise<WorkspaceRequisitesDto> {
    await this.assertCanManage(userId, workspaceId);
    const head = await this.legal.ensureHeadLegalEntity(workspaceId);
    await this.db.$transaction(async (tx) => {
      const count = await tx.workspaceBankAccount.count({ where: { legalEntityId: head.id } });
      if (count >= REQUISITE_LIMITS.maxBankAccountsPerWorkspace) {
        throw badRequest('workspace.tooManyBankAccounts');
      }
      // Первый счёт — основной сам; явный isPrimary снимает флаг с прочих.
      const makePrimary = dto.isPrimary || count === 0;
      if (makePrimary) {
        await tx.workspaceBankAccount.updateMany({
          where: { legalEntityId: head.id, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      await tx.workspaceBankAccount.create({
        data: {
          workspaceId,
          legalEntityId: head.id,
          iban: dto.iban,
          bankName: dto.bankName,
          bik: dto.bik,
          isPrimary: makePrimary,
        },
      });
    });
    return (await this.serializeRequisites(workspaceId)) as WorkspaceRequisitesDto;
  }

  async updateBankAccount(
    userId: string,
    workspaceId: string,
    accountId: string,
    dto: UpdateBankAccountInput,
  ): Promise<WorkspaceRequisitesDto> {
    await this.assertCanManage(userId, workspaceId);
    const head = await this.legal.ensureHeadLegalEntity(workspaceId);
    await this.db.$transaction(async (tx) => {
      const acc = await tx.workspaceBankAccount.findFirst({
        where: { id: accountId, legalEntityId: head.id },
      });
      if (!acc) throw notFound('workspace.bankAccountNotFound');
      if (dto.isPrimary) {
        await tx.workspaceBankAccount.updateMany({
          where: { legalEntityId: head.id, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      await tx.workspaceBankAccount.update({
        where: { id: acc.id },
        data: {
          ...(dto.iban !== undefined ? { iban: dto.iban } : {}),
          ...(dto.bankName !== undefined ? { bankName: dto.bankName } : {}),
          ...(dto.bik !== undefined ? { bik: dto.bik } : {}),
          ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
        },
      });
    });
    return (await this.serializeRequisites(workspaceId)) as WorkspaceRequisitesDto;
  }

  async removeBankAccount(
    userId: string,
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceRequisitesDto> {
    await this.assertCanManage(userId, workspaceId);
    const head = await this.legal.ensureHeadLegalEntity(workspaceId);
    await this.db.$transaction(async (tx) => {
      const acc = await tx.workspaceBankAccount.findFirst({
        where: { id: accountId, legalEntityId: head.id },
      });
      if (!acc) throw notFound('workspace.bankAccountNotFound');
      await tx.workspaceBankAccount.delete({ where: { id: acc.id } });
      // Основной удалили — роль переходит старейшему из оставшихся: «основной» не
      // должен пропадать, пока есть хоть один счёт (на него смотрят документы).
      if (acc.isPrimary) {
        const next = await tx.workspaceBankAccount.findFirst({
          where: { legalEntityId: head.id },
          orderBy: { createdAt: 'asc' },
        });
        if (next) await tx.workspaceBankAccount.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
    return (await this.serializeRequisites(workspaceId)) as WorkspaceRequisitesDto;
  }

  /** Роль произвольного пользователя в организации (для валидации директора) */
  private async getMyRoleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const rows = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (!rows.length) return null;
    return rows
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
  }

  /** Реквизиты = ГОЛОВНОЕ юрлицо организации (совместимость старой ручки). */
  private async serializeRequisites(workspaceId: string): Promise<WorkspaceRequisitesDto> {
    const head = await this.legal.ensureHeadLegalEntity(workspaceId);
    const [req, accounts] = await Promise.all([
      this.db.legalEntity.findUnique({ where: { id: head.id } }),
      this.db.workspaceBankAccount.findMany({
        where: { legalEntityId: head.id },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);
    const shapedAccounts = await this.legal.shapeBankAccounts(workspaceId, accounts);
    // Директор мог быть уволен после записи — имя всё равно показываем (реквизиты
    // не рвутся увольнением; актуальность подписанта сверяется на выдаче документа).
    const director = req?.directorUserId
      ? await this.db.user.findUnique({
          where: { id: req.directorUserId },
          select: { firstName: true, lastName: true },
        })
      : null;
    return {
      orgForm: req?.orgForm ?? null,
      taxRegime: req?.taxRegime ?? null,
      legalName: req?.legalName ?? null,
      bin: req?.bin ?? null,
      legalAddress: req?.legalAddress ?? null,
      kbe: req?.kbe ?? null,
      vatPayer: req?.vatPayer ?? false,
      vatSeries: req?.vatSeries ?? null,
      vatNumber: req?.vatNumber ?? null,
      vatDate: req?.vatDate ? req.vatDate.toISOString().slice(0, 10) : null,
      directorUserId: req?.directorUserId ?? null,
      directorName: director ? fullName(director) : null,
      // Фраза — для экрана, в языке зрителя; хранится структура
      signBasis: req
        ? composeSignBasis(
            signBasisPartsOf(req),
            (key, values) => this.i18n.translate(`counterparties.${key}`, values),
            (iso) => this.i18n.format().date(iso),
          )
        : null,
      signBasisParts: req ? signBasisPartsOf(req) : null,
      bankAccounts: shapedAccounts,
    };
  }

  /**
   * Отправить в архив (владелец). Ничего не удаляет — гаснет флаг и ставится дата
   * архивации, от которой ретеншн-крон отсчитывает `archiveRetentionDays` до полного
   * удаления. Всё это время возврат — в один клик (`restoreWorkspace`).
   *
   * Идемпотентно: переход «живая → архив» status-guarded. Повторный архив (двойной
   * клик, повтор запроса, уборка сьюта) — не ошибка и не событие: он не переставляет
   * `archivedAt` (иначе отсчёт до удаления начинался бы заново) и не пишет второе
   * событие журнала и аналитики.
   */
  async deactivateWorkspace(userId: string, workspaceId: string): Promise<void> {
    await this.assertOwner(userId, workspaceId);
    const archived = await this.db.$transaction(async (tx) => {
      const { count } = await tx.workspace.updateMany({
        where: { id: workspaceId, isActive: true },
        data: { isActive: false, archivedAt: new Date() },
      });
      if (count === 0) return false;
      // Журнал безопасности организации (core/audit): архив — событие той же транзакцией
      await this.audit.record(tx, { key: 'org.workspace.archived', workspaceId, target: { type: 'workspace', id: workspaceId }, details: {} });
      await this.analytics.track(tx, 'workspaces.workspace.archived', {}, { userId, workspaceId });
      return true;
    });
    // Счётчик «Пространств» в /users/me считает ЖИВЫЕ организации и кэшируется 5 минут —
    // без сброса человек полчаса видит «2 Пространств» над пустым списком.
    if (archived) await this.redis.invalidateUserProfile(userId);
  }

  /**
   * Дев-полигон: полное удаление организации сейчас, не дожидаясь ретеншна. Тот же путь,
   * что у настоящего удаления — владелец, сначала архив, потом `purgeWorkspace`. Без этих
   * проверок любой вошедший на общей базе разработки стирал бы чужую ЖИВУЮ организацию.
   */
  async purgeArchivedWorkspaceNow(userId: string, workspaceId: string): Promise<void> {
    const ws = await this.assertOwner(userId, workspaceId);
    if (ws.isActive) throw badRequest('workspace.notArchived');
    await this.purgeWorkspace(workspaceId);
  }

  /**
   * Архив: деактивированные организации, которыми человек ВЛАДЕЕТ. Видит только
   * владелец — восстановить может он один, а сотрудникам выключенная организация
   * ничего не даёт (данные её сервисов и так закрыты).
   */
  async listArchivedWorkspaces(userId: string): Promise<Workspace[]> {
    const workspaces = await this.db.workspace.findMany({
      where: { ownerId: userId, isActive: false },
      include: { _count: { select: { members: true } } },
      orderBy: { archivedAt: 'desc' },
    });
    return this.serializeWorkspaces(workspaces.map((w) => ({ ws: w, membersCount: w._count.members, myRole: 'owner' as const })));
  }

  /**
   * Вернуть деактивированную организацию в строй (владелец). Деактивация ничего, кроме
   * флага, не трогает — роли, справочники и данные сервисов остаются на месте, поэтому
   * восстановление симметрично и ничего не пересобирает.
   */
  async restoreWorkspace(userId: string, workspaceId: string): Promise<void> {
    const ws = await this.assertOwner(userId, workspaceId);
    if (ws.isActive) return; // идемпотентно: повторный клик — не ошибка
    // Потолок проверяем и здесь (в транзакции, под локом тарифа): иначе восстановлением
    // можно обойти лимит createWorkspace.
    const restored = await this.db.$transaction(async (tx) => {
      await this.entitlements.assertCanCreate(tx, { type: 'user', id: userId }, 'workspaces.maxOwned');
      // Status-guarded: проверка выше — чтение ДО транзакции, два параллельных возврата
      // прошли бы её оба и записали бы событие дважды
      const { count } = await tx.workspace.updateMany({
        where: { id: workspaceId, isActive: false },
        data: { isActive: true, archivedAt: null },
      });
      if (count === 0) return false;
      await this.audit.record(tx, { key: 'org.workspace.restored', workspaceId, target: { type: 'workspace', id: workspaceId }, details: {} });
      return true;
    });
    if (restored) await this.redis.invalidateUserProfile(userId);
  }

  /**
   * Полное, безвозвратное удаление организации. Каскад в схеме закрывает только семь
   * таблиц (члены, приглашения, справочники, назначения, комнаты офиса), поэтому всё
   * остальное сносим руками — и порядок здесь несущий:
   *
   * • `tasks.workspace_id` стоит на **SET NULL**. Удалить организацию, не тронув её
   *   задачи, значит не убрать их, а превратить в ЛИЧНЫЕ задачи людей — мусор переехал
   *   бы на видное место. Поэтому задачи удаляются явно и ПЕРВЫМИ.
   * • Ещё десять таблиц (процессы, хроника, звонки, ресурсы, tuples доступа, роли)
   *   ссылаются на `workspace_id` вообще без FK — их строки просто повисли бы навсегда.
   * • Чаты задач и встреч физически принадлежат мессенджеру и на организацию не
   *   ссылаются — ищем их через задачи и комнаты, иначе останутся в списке чатов
   *   людей с мёртвым заголовком.
   *
   * НЕ трогаем осознанно: счета/валюты кошелька, магазин и книгу финансов организации.
   * Журнал двойной записи неизменяем — удаление счёта ломает инвариант Σ=0 и ночную
   * сверку WalletCron. Без организации они недостижимы.
   */
  async purgeWorkspace(workspaceId: string): Promise<void> {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!ws) return;

    // Фаза 1 — данные в движках и сервисах без внешнего ключа на организацию. До строки
    // организации: сбой здесь оставляет её на месте, и ретеншн повторит каскад целиком.
    await this.purgeWorkspaceData(workspaceId);

    const [tasks, rooms, positions, departments, branches] = await Promise.all([
      this.db.task.findMany({ where: { workspaceId }, select: { id: true } }),
      this.db.officeRoom.findMany({ where: { workspaceId }, select: { id: true } }),
      this.db.staffPosition.findMany({ where: { workspaceId }, select: { id: true } }),
      this.db.staffDepartment.findMany({ where: { workspaceId }, select: { id: true } }),
      this.db.staffBranch.findMany({ where: { workspaceId }, select: { id: true } }),
    ]);
    const taskIds = tasks.map((t) => t.id);
    const roomIds = rooms.map((r) => r.id);
    // Оси оргструктуры: их рёбра в движке прав (position#holder, department#member|head,
    // branch#member|head, гранты «отделу продаж» как получателю) не несут workspaceId и
    // FK — без явной чистки остались бы сиротами навсегда. StaffDeputy каскадится FK.
    const orgAxisIds = [...positions, ...departments, ...branches].map((r) => r.id);
    const chats = await this.db.chat.findMany({
      where: {
        OR: [
          { parentType: 'task', parentId: { in: taskIds } },
          { parentType: 'office_room', parentId: { in: roomIds } },
        ],
      },
      select: { id: true },
    });
    const chatIds = chats.map((c) => c.id);
    const refIds = [workspaceId, ...taskIds];

    let consentsAfterPurge: (() => Promise<void>) | null = null;
    await this.db.$transaction(async (tx) => {
      // Ключи API и боты организации гаснут, KEK — на уничтожение (crypto-shredding, 30 дней)
      await this.keysCascades.onWorkspacePurge(tx, workspaceId);
      // Тариф: подписка, гранты, оверрайды и счётчики организации — строки без FK
      await this.entitlements.forgetSubject(tx, { type: 'workspace', id: workspaceId });
      // Аналитика: роллапы с измерением организации — сразу, сырьё — джобом
      await this.analytics.forgetWorkspace(tx, workspaceId);
      // Правила видимости организации (полиморфный владелец, без FK) — иначе пережили бы её (R1)
      await this.visibilityPolicies.purgeOwner(tx, 'workspace', workspaceId);
      // Согласия организации (условия для организаций, соглашение об обработке ПДн) прекращаются
      // вместе с ней; сами записи приёмки остаются — это доказательство, а не данные организации
      consentsAfterPurge = (await this.consents.revokeAllForSubject(tx, { type: 'workspace', id: workspaceId }, 'workspace_purged', null)).afterCommit;
      await tx.searchDocument.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.chat.deleteMany({ where: { id: { in: chatIds } } }); // каскад: сообщения, участники, отложенные
      await tx.chatterEntry.deleteMany({
        where: { OR: [{ workspaceId }, { refType: 'task', refId: { in: taskIds } }] },
      });
      await tx.task.deleteMany({ where: { id: { in: taskIds } } }); // каскад: участники, теги
      await tx.processInstance.deleteMany({ where: { workspaceId } });
      await tx.processDefinition.deleteMany({ where: { workspaceId } });
      await tx.processTrigger.deleteMany({ where: { workspaceId } });
      await tx.processCredential.deleteMany({ where: { workspaceId } });
      await tx.callRecording.deleteMany({ where: { workspaceId } });
      await tx.callSession.deleteMany({ where: { workspaceId } });
      await tx.resource.deleteMany({ where: { workspaceId } });
      await tx.relationTuple.deleteMany({
        where: { OR: [{ resourceId: { in: refIds } }, { subjectId: { in: refIds } }] },
      });
      if (orgAxisIds.length) {
        await tx.relationTuple.deleteMany({
          where: {
            OR: [
              { resourceType: { in: ['position', 'department', 'branch'] }, resourceId: { in: orgAxisIds } },
              { subjectType: { in: ['position', 'department', 'branch'] }, subjectId: { in: orgAxisIds } },
            ],
          },
        });
      }
      await tx.userRole.deleteMany({ where: { context: WS_CONTEXT, tenantId: workspaceId } });
      // `Notification.workspaceId` — колонка без FK: строки пережили бы организацию и
      // остались бы «призраком контекста» (в бейдже есть, отфильтровать нечем).
      await this.notifications.archiveWorkspaceRowsForAll(tx, workspaceId);
      // Журнал безопасности организации ПЕРЕЖИВАЕТ удаление (строки без FK, срок — по закону)
      const members = await tx.workspaceMember.count({ where: { workspaceId } });
      await this.audit.record(tx, { key: 'org.workspace.purged', workspaceId, subjectUserId: ws.ownerId, actor: { kind: 'system' }, target: { type: 'workspace', id: workspaceId }, details: { members } });
      await tx.workspace.delete({ where: { id: workspaceId } });
    });

    // KEK организации ушёл на уничтожение — кэши keystore сбрасываются ПОСЛЕ коммита
    await this.keysCascades.afterScopeDestroyCommitted();
    // Кэш мягкого шлюза согласий организации — после коммита
    await (consentsAfterPurge as (() => Promise<void>) | null)?.().catch(() => undefined);
    await this.roles.invalidateUserCache(ws.ownerId);
    await this.redis.invalidateUserProfile(ws.ownerId);
    this.logger.log(`Workspace ${workspaceId} purged by the archive retention`);
  }

  /**
   * Фаза 1 окончательного удаления: данные организации, живущие в движках и сервисах без
   * внешнего ключа на неё. Порядок несущий:
   *  1. незакрытые согласования и подписи отменяются — стопки людей чистеют, поставленные
   *     подписи остаются доказательствами;
   *  2. сервисы с полиморфным владельцем (Диск, Заметки — `WorkspacePurgeRegistry`)
   *     стирают свои данные своим путём;
   *  3. офисные документы проходят единственную точку конца жизни;
   *  4. все оставшиеся файлы организации — системным удалением: личный архив КЭДО
   *     (`blocksDeletion`) и доказательства подписи пропускаются и живут дальше;
   *  5. ссылки наружу отзываются, гости ссылок (имя + номер — ПДн) удаляются.
   * Каждый шаг идемпотентен и работает для организации, строки которой уже нет (уборка
   * хвостов прошлых удалений). Сбой БРОСАЕТСЯ — каскад прерывается целиком.
   */
  async purgeWorkspaceData(workspaceId: string): Promise<void> {
    await this.approvals.cancelAllForWorkspace(workspaceId);
    await this.sign.cancelAllForWorkspace(workspaceId);
    for (const [key, hook] of this.purgeHooks.entries()) {
      try {
        await hook.purge(workspaceId);
      } catch (err) {
        throw new Error(`workspace purge hook "${key}" failed for ${workspaceId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await this.docs.archiveAllOwnedBy('workspace', workspaceId);
    await this.files.systemDeleteAllOwnedBy('workspace', workspaceId);
    await this.shareLinks.forgetWorkspace(workspaceId);
  }

  /**
   * Организации, которых УЖЕ НЕТ, а их данные в движках ещё живы (удалены до того, как
   * каскад научился чистить Диск, заметки, документы, файлы, ссылки и заявки, либо сырым
   * удалением строки). Живые и архивные организации сюда не попадают по построению
   * (`EXCEPT workspaces`). Файлы, которые каскад законно оставляет — доказательства
   * подписи и файлы под защищающей привязкой (личный архив), — хвостом не считаются.
   */
  async orphanedWorkspaceIds(): Promise<string[]> {
    const guarded = this.files.deletionGuardedRefTypes();
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT owner_id AS id FROM drive_spaces WHERE owner_type = 'workspace'
      UNION SELECT owner_id FROM note_spaces WHERE owner_type = 'workspace'
      UNION SELECT owner_id FROM documents WHERE owner_type = 'workspace' AND status = 'active'
      UNION SELECT fo.owner_id FROM file_objects fo
        WHERE fo.owner_type = 'workspace' AND fo.status <> 'deleted'
          AND fo.profile <> ALL(${[...EVIDENCE_FILE_PROFILES]}::text[])
          AND NOT EXISTS (SELECT 1 FROM file_links fl WHERE fl.file_id = fo.id AND fl.ref_type = ANY(${guarded}::text[]))
      UNION SELECT workspace_id FROM share_links WHERE workspace_id IS NOT NULL AND revoked_at IS NULL
      UNION SELECT owner_id FROM share_links WHERE owner_type = 'workspace' AND revoked_at IS NULL
      UNION SELECT owner_id FROM share_link_guests WHERE owner_type = 'workspace'
      UNION SELECT workspace_id FROM sign_requests WHERE workspace_id IS NOT NULL AND status = 'pending'
      UNION SELECT workspace_id FROM approval_requests WHERE workspace_id IS NOT NULL AND status = 'pending'
      EXCEPT SELECT id FROM workspaces`;
    return rows.map((r) => r.id).sort();
  }

  /** Что именно висит за организациями, которых нет, — отчёт сухого прогона уборки */
  async orphanReport(ids: string[]): Promise<Record<string, number>> {
    if (!ids.length) return {};
    const inIds = { in: ids };
    const [driveSpaces, driveNodes, noteSpaces, notes, documents, files, shareLinks, guests, signRequests, approvalRequests] = await Promise.all([
      this.db.driveSpace.count({ where: { ownerType: 'workspace', ownerId: inIds } }),
      this.db.driveNode.count({ where: { space: { ownerType: 'workspace', ownerId: inIds } } }),
      this.db.noteSpace.count({ where: { ownerType: 'workspace', ownerId: inIds } }),
      this.db.note.count({ where: { space: { ownerType: 'workspace', ownerId: inIds } } }),
      this.db.document.count({ where: { ownerType: 'workspace', ownerId: inIds, status: 'active' } }),
      this.db.fileObject.count({ where: { ownerType: 'workspace', ownerId: inIds, status: { not: 'deleted' }, profile: { notIn: [...EVIDENCE_FILE_PROFILES] } } }),
      this.db.shareLink.count({ where: { OR: [{ workspaceId: inIds }, { ownerType: 'workspace', ownerId: inIds }], revokedAt: null } }),
      this.db.shareLinkGuest.count({ where: { ownerType: 'workspace', ownerId: inIds } }),
      this.db.signRequest.count({ where: { workspaceId: inIds, status: 'pending' } }),
      this.db.approvalRequest.count({ where: { workspaceId: inIds, status: 'pending' } }),
    ]);
    return { driveSpaces, driveNodes, noteSpaces, notes, documents, files, shareLinks, guests, signRequests, approvalRequests };
  }

  /**
   * Предупредить владельцев, у кого архивная организация вот-вот исчезнет: за 7, 3 и 1
   * день до удаления. Возвращает число отправленных.
   *
   * Берётся ПЕРВЫЙ рубеж, под который попадает остаток (`daysLeft <= m`, список по
   * возрастанию) — то есть за прогон уходит максимум одно письмо на организацию. Если
   * крон простоял несколько дней, человек получит актуальное «остался 1 день», а не
   * пачку из трёх просроченных. Повтор гасит `dedupKey` (unique в БД): каждый рубеж
   * отправляется ровно один раз, сколько бы раз крон ни прогнали.
   */
  async warnExpiringArchives(): Promise<number> {
    const maxWarn = Math.max(...WORKSPACE_ARCHIVE_WARN_DAYS);
    // Интересуют только те, кому осталось не больше самого раннего рубежа.
    const horizon = new Date(
      Date.now() -
        (WORKSPACE_LIMITS.archiveRetentionDays - maxWarn) * 24 * 3600 * 1000,
    );
    const rows = await this.db.workspace.findMany({
      where: { isActive: false, archivedAt: { not: null, lt: horizon } },
      select: { id: true, name: true, ownerId: true, archivedAt: true },
      take: 500,
    });

    let sent = 0;
    for (const w of rows) {
      const purgeAt = workspacePurgeAt(w.archivedAt as Date);
      const daysLeft = daysUntilPurge(purgeAt);
      // 0 бывает только если удаление в этом же прогоне упало: срок уже вышел, и
      // «будет удалена через 0 дней» — бессмыслица. Молчим, снесёт следующий заход.
      if (daysLeft === 0) continue;
      const milestone = WORKSPACE_ARCHIVE_WARN_DAYS.find((m) => daysLeft <= m);
      if (milestone === undefined) continue; // ещё рано (или уже пора удалять — это дело purge)
      try {
        await this.notifications.send(null, {
          type: 'workspace.archive.expiring',
          to: [{ userId: w.ownerId }],
          payload: {
            workspaceId: w.id,
            workspaceName: w.name,
            days: daysLeft,
            purgeDateIso: purgeAt.toISOString().slice(0, 10),
          },
          ref: { type: 'workspace', id: w.id },
          reason: 'owner',
          actionUrl: '/dashboard',
          // Рубеж, а не остаток: иначе один и тот же рубеж слал бы письмо каждый день.
          idempotencyKey: `wsarch:${w.id}:${milestone}`,
        });
        sent++;
      } catch (err) {
        // Упавшее уведомление не должно останавливать остальные — и уж точно не
        // должно мешать удалению: оно идёт отдельным проходом.
        this.logger.error(
          `warnExpiringArchives ${w.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return sent;
  }

  /** Ретеншн архива: удалить организации, пролежавшие в нём дольше срока. Зовёт крон. */
  async purgeExpiredArchives(): Promise<number> {
    const cutoff = new Date(
      Date.now() - WORKSPACE_LIMITS.archiveRetentionDays * 24 * 3600 * 1000,
    );
    const due = await this.db.workspace.findMany({
      where: { isActive: false, archivedAt: { not: null, lt: cutoff } },
      select: { id: true },
      take: 100, // потолок на прогон: крон ежедневный, хвост доберёт завтра
    });
    let purged = 0;
    for (const w of due) {
      try {
        await this.purgeWorkspace(w.id);
        purged++;
      } catch (err) {
        // Одна сломанная организация не должна останавливать уборку остальных
        this.logger.error(
          `purgeWorkspace ${w.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return purged;
  }

  async transferOwnership(
    userId: string,
    workspaceId: string,
    toUserId: string,
  ): Promise<void> {
    await this.assertOwner(userId, workspaceId);
    if (toUserId === userId) {
      throw badRequest('workspace.alreadyOwner');
    }
    const targetRole = await this.getMyRole(toUserId, workspaceId);
    if (!targetRole) {
      throw badRequest('workspace.newOwnerNotMember');
    }

    const [actorName, targetName] = await Promise.all([
      this.userName(userId),
      this.userName(toUserId),
    ]);
    await this.db.$transaction(async (tx) => {
      // Владелец без членства — организация без хозяина: снятие, закоммиченное раньше, побеждает
      if (!(await this.lockMemberRowTx(tx, workspaceId, toUserId))) throw badRequest('workspace.newOwnerNotMember');
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { ownerId: toUserId },
      });
      // New owner → owner; previous owner → admin (single role each) — all atomic,
      // so ownership can't split (two owners / zero owners) on a partial failure.
      await this.setSoleWorkspaceRoleTx(tx, toUserId, workspaceId, 'owner', userId);
      await this.setSoleWorkspaceRoleTx(tx, userId, workspaceId, 'admin', userId);
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId: userId,
        actorName,
        typeKey: 'staff.ownership_transferred',
        payload: { targetUserId: toUserId, targetName },
      });
      await this.audit.record(tx, {
        key: 'org.ownership.transferred',
        workspaceId,
        target: { type: 'user', id: toUserId },
        related: { previousOwnerId: userId },
        details: {},
      });
      // Роли обоих — тоже события (человек видит «Роль: Администратор → Владелец» в своей ленте)
      await this.audit.record(tx, { key: 'org.role.changed', workspaceId, target: { type: 'user', id: toUserId }, details: { from: targetRole, to: 'owner', source: 'ownership' } });
      await this.audit.record(tx, { key: 'org.role.changed', workspaceId, target: { type: 'user', id: userId }, details: { from: 'owner', to: 'admin', source: 'ownership' } });
    });

    // Both users' role rows changed inside the tx → bust both caches now.
    await this.roles.invalidateUserCache(toUserId);
    await this.roles.invalidateUserCache(userId);
    // Владелец — фолбэк вертикали («руководитель не найден → владелец»): снимок графа сбросить.
    await this.staff.invalidateOrgGraph(workspaceId);
  }

  // ============================================================
  // Members
  // ============================================================

  async listMembers(userId: string, workspaceId: string): Promise<WorkspaceMember[]> {
    // Ростер закрыт от Подрядчика (Коллаб-модель: он не видит команду).
    await this.assertTeamMember(userId, workspaceId);

    const [members, roleRows, assignmentsByUser] = await Promise.all([
      this.db.workspaceMember.findMany({
        where: { workspaceId },
        include: { user: { select: USER_CARD_SELECT } },
        orderBy: { joinedAt: 'asc' },
      }),
      this.db.userRole.findMany({
        where: { context: WS_CONTEXT, tenantId: workspaceId, isActive: true },
        select: { userId: true, role: true },
      }),
      this.staff.getAssignmentsByUser(workspaceId),
    ]);

    // Highest role per user (defensive — normally one role each).
    const roleByUser = new Map<string, WorkspaceRole>();
    for (const r of roleRows) {
      const role = r.role as WorkspaceRole;
      const cur = roleByUser.get(r.userId);
      if (!cur || ROLE_RANK[role] > ROLE_RANK[cur]) roleByUser.set(r.userId, role);
    }

    // Карточки — ЛИЧНЫЕ правила каждого человека глазами коллеги (core/visibility, `user.card`):
    // одна проекция с Окружением, политики и связи — один раз на весь ростер. Реквизитов и карт
    // в СПИСКЕ нет намеренно: комплект для договоров отдаёт `getMember` по ОДНОМУ человеку.
    const viewer = this.memberViewer(workspaceId);
    const cards = await this.userCards.cards(viewer, members.map((m) => m.user));
    return members.map((m, i) => ({
      id: m.id,
      workspaceId,
      userId: m.userId,
      userName: this.fullName(m.user),
      // Фото — решение ЧЕЛОВЕКА (личное поле user.card), организация его не раскрывает
      userAvatar: visibleOr(cards[i]!.avatar, null),
      role: roleByUser.get(m.userId) ?? 'staff',
      assignments: assignmentsByUser.get(m.userId) ?? [],
      card: cards[i]!,
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  /** Зритель ростера: «шляпа» — эта организация (служебные правила — её, личные — самих людей). */
  private memberViewer(workspaceId: string): VisibilityViewer {
    return this.visibility.viewer('api', { workspaceId });
  }

  /**
   * ОДИН сотрудник с реквизитным блоком (договоры, трудоустройство, выплаты). Кто что
   * видит — правила организации (core/visibility, `staff.member`: ИИН, адрес, удостоверение,
   * карта — владельцу и админу МАСКОЙ с раскрытием по одной записи, остальным скрыто, самому —
   * полностью). Скрытые поля из БД НЕ читаются вовсе (`readableFields`: нет расшифровки — нет
   * `pii.read`); полный номер карты не расшифровывается никогда — только последние четыре.
   */
  async getMember(userId: string, workspaceId: string, targetUserId: string): Promise<WorkspaceMember> {
    await this.assertTeamMember(userId, workspaceId);
    const row = await this.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      include: { user: { select: USER_CARD_SELECT } },
    });
    if (!row) throw notFound('staff.notInWorkspace');
    const roleRow = await this.db.userRole.findFirst({
      where: { userId: targetUserId, context: WS_CONTEXT, tenantId: workspaceId, isActive: true },
      select: { role: true },
      orderBy: { grantedAt: 'desc' },
    });
    const viewer = this.memberViewer(workspaceId);
    const [card, requisites, assignments] = await Promise.all([
      this.userCards.card(viewer, row.user),
      this.memberRequisites(viewer, workspaceId, targetUserId),
      this.staff.getAssignmentsByUser(workspaceId).then((m) => m.get(targetUserId) ?? []),
    ]);
    return markShaped({
      id: row.id,
      workspaceId,
      userId: row.userId,
      userName: this.fullName(row.user),
      userAvatar: visibleOr(card.avatar, null),
      role: (roleRow?.role as WorkspaceRole) ?? 'staff',
      assignments,
      card,
      requisites,
      joinedAt: row.joinedAt.toISOString(),
    });
  }

  /** Реквизитный блок сотрудника по плану зрителя (`staff.member`). */
  private async memberRequisites(viewer: VisibilityViewer, workspaceId: string, targetUserId: string): Promise<MemberRequisites> {
    const readable = await this.visibility.readableFields(viewer, 'staff.member', workspaceId);
    const want = (k: string) => readable.has(k);
    const needUser = ['iin', 'residentialAddress', 'idDocNumber', 'idDocIssuedBy', 'idDocIssuedAt'].some(want);
    const needCard = ['paymentCardPan', 'paymentCardIban', 'paymentCardHolder', 'paymentCardExpiry'].some(want);
    const [u, card] = await Promise.all([
      needUser
        ? this.db.user.findUnique({
            where: { id: targetUserId },
            select: {
              iin: want('iin'),
              residentialAddress: want('residentialAddress'),
              idDocNumber: want('idDocNumber'),
              idDocIssuedBy: want('idDocIssuedBy'),
              idDocIssuedAt: want('idDocIssuedAt'),
            },
          })
        : Promise.resolve(null),
      needCard ? this.paymentCards.primaryCardsLiteFor([targetUserId], { iban: want('paymentCardIban') }).then((m) => m.get(targetUserId) ?? null) : Promise.resolve(null),
    ]);
    const s = await this.visibility.shapeOne(viewer, 'staff.member', {
      ref: { recordId: targetUserId, subjectId: targetUserId, workspaceId },
      values: {
        iin: u?.iin ?? null,
        residentialAddress: u?.residentialAddress ?? null,
        idDocNumber: u?.idDocNumber ?? null,
        idDocIssuedBy: u?.idDocIssuedBy ?? null,
        idDocIssuedAt: u?.idDocIssuedAt ? u.idDocIssuedAt.toISOString().slice(0, 10) : null,
        ...(card
          ? {
              paymentCardPan: card.panLast4,
              paymentCardIban: card.iban,
              paymentCardHolder: card.holderName,
              paymentCardExpiry: `${card.expYear < 100 ? 2000 + card.expYear : card.expYear}-${String(card.expMonth).padStart(2, '0')}-01`,
            }
          : {}),
      },
    });
    const hiddenCount = Object.values(s).filter((v) => isHidden(v)).length;
    return markShaped({
      iin: s.iin as MemberRequisites['iin'],
      residentialAddress: s.residentialAddress as MemberRequisites['residentialAddress'],
      idDocNumber: s.idDocNumber as MemberRequisites['idDocNumber'],
      idDocIssuedBy: s.idDocIssuedBy as MemberRequisites['idDocIssuedBy'],
      idDocIssuedAt: s.idDocIssuedAt as MemberRequisites['idDocIssuedAt'],
      paymentCard: card
        ? markShaped({
            pan: s.paymentCardPan as NonNullable<MemberRequisites['paymentCard']>['pan'],
            iban: s.paymentCardIban as NonNullable<MemberRequisites['paymentCard']>['iban'],
            holderName: s.paymentCardHolder as NonNullable<MemberRequisites['paymentCard']>['holderName'],
            expiry: s.paymentCardExpiry as NonNullable<MemberRequisites['paymentCard']>['expiry'],
          })
        : null,
      hiddenCount,
    });
  }

  /**
   * Смена роли. Правила лестницы:
   *   - роль владельца не трогается (только transfer);
   *   - назначить/снять Админа может ТОЛЬКО Владелец (админ не трогает админов);
   *   - админ управляет ролями до Менеджера включительно;
   *   - contractor вручную не назначается (только программно сервисами) — это
   *     отрезано уже на Zod-схеме (его нет в ASSIGNABLE), здесь — страховка.
   */
  async updateMember(
    userId: string,
    workspaceId: string,
    targetUserId: string,
    data: { role: WorkspaceRole },
  ): Promise<void> {
    const actorRole = await this.assertCanManage(userId, workspaceId);
    const ws = await this.getWorkspaceOrThrow(workspaceId);

    if (targetUserId === ws.ownerId) {
      throw badRequest('workspace.ownerRoleImmutable');
    }
    const targetRole = await this.getMyRole(targetUserId, workspaceId);
    if (!targetRole) throw notFound('staff.notInWorkspace');

    if (data.role === 'owner' || data.role === 'contractor') {
      throw badRequest('workspace.roleNotAssignable');
    }
    if (actorRole !== 'owner') {
      if (data.role === 'admin') {
        throw forbidden('workspace.adminGrantOwnerOnly');
      }
      if (targetRole === 'admin') {
        throw forbidden('workspace.adminChangeOwnerOnly');
      }
    }

    if (data.role !== targetRole) {
      const [actorName, targetName] = await Promise.all([this.userName(userId), this.userName(targetUserId)]);
      // Смена роли, её хроника, событие журнала безопасности и уведомление — ОДНОЙ транзакцией:
      // раньше хроника и уведомление шли после эффекта без транзакции и могли потеряться
      const afterKeys = await this.db.$transaction(async (tx) => {
        if (!(await this.lockMemberRowTx(tx, workspaceId, targetUserId))) throw notFound('staff.notInWorkspace');
        await this.setSoleWorkspaceRoleTx(tx, targetUserId, workspaceId, data.role, userId);
        // Понижение с admin: личные ключи человека для данных организации гаснут, его боты —
        // на решение владельца (право иметь ключи организации — только owner/admin)
        const after = await this.keysCascades.onRoleChanged(tx, workspaceId, targetUserId, targetRole, data.role, userId);
        await this.chatter.log(tx, {
          refType: 'workspace',
          refId: workspaceId,
          workspaceId,
          actorId: userId,
          actorName,
          typeKey: 'staff.role_changed',
          changes: [
            {
              field: 'role',
              label: this.i18n.translateFor(SOURCE_LOCALE, 'chatter.fields.staff.role'),
              from: this.roleName(targetRole),
              to: this.roleName(data.role),
              // Снимок — фолбэк, правда — в `raw` КЛЮЧАМИ: «Сотрудник → Менеджер»
              // собирается в языке зрителя, а не застывает в языке источника.
              raw: {
                from: `common.role.workspace.${targetRole}`,
                to: `common.role.workspace.${data.role}`,
                kind: 'key' as const,
              },
            },
          ],
          payload: { targetUserId, targetName },
        });
        await this.audit.record(tx, { key: 'org.role.changed', workspaceId, target: { type: 'user', id: targetUserId }, details: { from: targetRole, to: data.role, source: 'manual' } });
        await this.notifications.send(tx, {
          type: 'workspace.role.changed',
          to: [{ userId: targetUserId }],
          payload: {
            workspaceId,
            workspaceName: ws.name,
            roleKey: `common.role.workspace.${data.role}`,
          },
          workspaceId,
          actorId: userId,
          actionUrl: `/workspaces/${workspaceId}`,
        });
        return after;
      });
      // Кэш ролей — ПОСЛЕ коммита (транзакционный вариант его не сбрасывает)
      await this.roles.invalidateUserCache(targetUserId);
      await afterKeys();
      // Роли живут в снимке оргструктуры (состав команды, ранги «вне структуры»).
      await this.staff.invalidateOrgGraph(workspaceId);
    }
  }

  /**
   * Действующий трудовой договор человека (КЭДО). Ленивый ModuleRef-резолв: прямая
   * инъекция HrModule в @Global-воркспейсы дала бы цикл (HR сам тянет Staff/Документы).
   * Ошибка резолва НЕ блокирует увольнение — гейт закрывает дыру, а не создаёт новую.
   */
  private async activeEmploymentOf(workspaceId: string, targetUserId: string): Promise<{ id: string } | null> {
    try {
      const hr = this.moduleRef.get<{
        liveEmployment: (ws: string, uid: string) => Promise<{ id: string; status: string } | null>;
      }>(DI_TOKENS.HrService, { strict: false });
      const employment = await hr.liveEmployment(workspaceId, targetUserId);
      return employment && employment.status === 'active' ? { id: employment.id } : null;
    } catch (err) {
      this.logger.error(`activeEmploymentOf: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Fire a member (owner/admin). Owner cannot be removed — transfer first. */
  /**
   * Право актора снять человека с членства — ОДНО правило для кнопки ростера и для галочки
   * «снять и членство» в увольнении КЭДО (там проверяется при создании приказа: галочка,
   * которую применение потом отвергнет, обещала бы то, чего не случится). Владелец/админ;
   * владельца снять нельзя; админа — только владелец. Живой трудовой договор сюда не входит:
   * это гейт самого снятия (увольнение закрывает договор раньше, чем снимает членство).
   */
  async assertCanRemoveMember(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
  ): Promise<{ ws: { name: string; ownerId: string }; targetRole: WorkspaceRole | null }> {
    const actorRole = await this.assertCanManage(actorId, workspaceId);
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    if (targetUserId === ws.ownerId) {
      throw badRequest('workspace.ownerNotRemovable');
    }
    const targetRole = await this.getMyRole(targetUserId, workspaceId);
    // Член без ролей (осиротевшая строка) снимается тем же путём: иначе его не убрать ничем
    if (!targetRole && !(await this.hasMemberRow(workspaceId, targetUserId))) throw notFound('staff.notInWorkspace');
    if (targetRole === 'admin' && actorRole !== 'owner') {
      throw forbidden('workspace.adminRemoveOwnerOnly');
    }
    return { ws, targetRole };
  }

  /**
   * `opts.hrActionId` — членство снимает применение кадрового действия «Увольнение» (КЭДО):
   * исполнитель в журнале — система, инициатор (`userId`, автор действия) — `onBehalfOf`.
   */
  async removeMember(userId: string, workspaceId: string, targetUserId: string, opts: { hrActionId?: string } = {}): Promise<void> {
    const { ws, targetRole } = await this.assertCanRemoveMember(userId, workspaceId, targetUserId);
    // Исключение из организации ≠ увольнение по ТК: договор живёт в КЭДО и после
    // ухода продолжал тикать сроками (ЕСУТД, испытательный, конец договора) по
    // человеку, которого в организации уже нет. Живой договор закрывается кадровым
    // действием «Увольнение» (там же есть галочка «снять и членство»).
    if (await this.activeEmploymentOf(workspaceId, targetUserId)) {
      // Машинный код остаётся прежним (клиент и сьюта ветвятся по нему), а фразу
      // подбирает фильтр в языке запроса.
      throw conflict('workspace.employmentActive', undefined, {
        code: WORKSPACE_ERROR_CODES.employmentActive,
      });
    }

    await this.releaseMemberFootprint(workspaceId, targetUserId, userId);
    const cut = await this.cutMembership(workspaceId, targetUserId, {
      exit: 'removed',
      keysReason: opts.hrActionId ? 'dismissed' : 'removed',
      actorId: userId,
      role: targetRole,
      hrActionId: opts.hrActionId,
    });
    // Строку уже снял параллельный вызов — хроника и уведомление принадлежат ему
    if (!cut) return;

    await this.chatter.log(null, {
      refType: 'workspace',
      refId: workspaceId,
      workspaceId,
      actorId: userId,
      actorName: await this.userName(userId),
      typeKey: 'staff.fired',
      payload: { targetUserId, targetName: await this.userName(targetUserId) },
    });
    // Шина — триггеры Процессов («Сотрудник уволен»); строки организации у человека
    // архивируются (не удаляются), новое уведомление ложится в «Личное» — он уже не член.
    this.events.emit('workspace.member.removed', { workspaceId, workspaceName: ws.name, userId: targetUserId }, 'WorkspacesService');
    await this.notifications.archiveWorkspaceRows(null, targetUserId, workspaceId);
    await this.notifications.send(null, {
      type: 'workspace.member.removed',
      to: [{ userId: targetUserId }],
      payload: { workspaceId, workspaceName: ws.name },
      workspaceId,
      actorId: userId,
    });
  }

  /** Voluntary leave (non-owner). */
  async leaveWorkspace(userId: string, workspaceId: string): Promise<void> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const myRole = await this.getMyRole(userId, workspaceId);
    if (!myRole) throw notFound('workspace.notMember');
    if (userId === ws.ownerId) {
      throw badRequest('workspace.ownerCannotLeave');
    }
    await this.releaseMemberFootprint(workspaceId, userId, userId);
    const cut = await this.cutMembership(workspaceId, userId, { exit: 'left', keysReason: 'left', actorId: userId, role: myRole });
    if (!cut) return;

    await this.chatter.log(null, {
      refType: 'workspace',
      refId: workspaceId,
      workspaceId,
      actorId: userId,
      actorName: await this.userName(userId),
      typeKey: 'staff.left',
    });
    // Правило стоит на ОБОИХ путях ухода: строки организации архивируются и у того, кто
    // вышел сам, — иначе они висят в бейдже, а чипа этой организации у него уже нет.
    await this.notifications.archiveWorkspaceRows(null, userId, workspaceId);
  }

  // ============================================================
  // Invitations
  // ============================================================

  /**
   * Найм («Пригласить сотрудника»). Manager+ (управляющий филиала нанимает сам — iiko).
   * РОЛЬ НЕ ВЫБИРАЕТСЯ: каждый наём — в Стажёра; повышение — вручную/бизнес-процессом.
   * Опционально должность+филиал «с порога»: при принятии назначение создаётся само.
   * Дневных лимитов и кулдаунов нет (решение продукта: «нанять всех за день»).
   */
  async inviteMember(
    userId: string,
    workspaceId: string,
    data: {
      phone: string;
      positionId?: string;
      branchIds?: string[];
      message?: string;
    },
  ): Promise<WorkspaceInvitation> {
    await this.assertStaffManage(userId, workspaceId);
    const ws = await this.getWorkspaceOrThrow(workspaceId);

    const target = await this.db.user.findUnique({
      where: { phone: data.phone },
      select: { id: true, deletedAt: true, firstName: true, lastName: true },
    });
    if (target && target.id === userId) {
      throw badRequest('workspace.cannotInviteSelf');
    }
    // Находимость по номеру (core/visibility): человек, не разрешивший нанимающему находить
    // себя, для организации неотличим от незарегистрированного номера — ни `toUserId` в ответе,
    // ни имени в журнале. Приглашение ему доставляется (принять — его решение). Поток номеров
    // от одной организации ограничен отдельно от личного потолка.
    await this.discoverability.throttleWorkspaceLookup(workspaceId);
    const hidden = !!target && !target.deletedAt && !(await this.discoverability.isDiscoverable(target.id, userId));
    if (target) {
      const existing = await this.db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: target.id } },
        select: { id: true },
      });
      if (existing) throw conflict('workspace.alreadyMember');
    }

    const pending = await this.db.workspaceInvitation.findFirst({
      where: { workspaceId, toPhone: data.phone, status: 'pending' },
      select: { id: true },
    });
    if (pending) throw conflict('workspace.invitationPending');

    const pendingCount = await this.db.workspaceInvitation.count({
      where: { workspaceId, status: 'pending' },
    });
    if (pendingCount >= WORKSPACE_LIMITS.maxPendingInvitationsPerWorkspace) {
      throw badRequest('workspace.invitationLimit');
    }
    // Места организации — тариф (core/entitlements, ключ `workspace.seats`): проверяем на
    // входе (тут, под локом строки организации) и на принятии (там — авторитетно, в
    // транзакции членства). Отказ — 402 `entitlement.seat_required`.
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`);
      await this.entitlements.assertCanCreate(tx, { type: 'workspace', id: workspaceId }, 'workspace.seats');
    });

    // Должность/филиалы — из справочников ЭТОЙ организации.
    if (data.positionId) {
      const pos = await this.db.staffPosition.findFirst({
        where: { id: data.positionId, workspaceId },
        select: { id: true },
      });
      if (!pos) throw notFound('staff.positionNotFound');
    }
    const branchIds = [...new Set(data.branchIds ?? [])];
    if (branchIds.length) {
      const found = await this.db.staffBranch.count({
        where: { id: { in: branchIds }, workspaceId },
      });
      if (found !== branchIds.length) throw notFound('staff.branchNotFound');
    }

    const expiresAt = new Date(
      Date.now() + WORKSPACE_LIMITS.invitationTtlDays * 24 * 60 * 60 * 1000,
    );
    const inv = await this.db.$transaction(async (tx) => {
      const created = await tx.workspaceInvitation.create({
        data: {
          workspaceId,
          invitedBy: userId,
          toUserId: target?.id ?? null,
          toPhone: data.phone,
          role: WORKSPACE_HIRE_ROLE,
          positionId: data.positionId ?? null,
          branchIds,
          message: data.message ?? null,
          expiresAt,
        },
        include: INVITATION_INCLUDE,
      });
      // Журнал безопасности: приглашение — событие организации (и человека, если он уже есть)
      await this.audit.record(tx, {
        key: 'org.member.invited',
        workspaceId,
        ...(created.toUserId && !hidden ? { target: { type: 'user', id: created.toUserId } } : { target: { type: 'workspace_invitation', id: created.id } }),
        details: { role: WORKSPACE_HIRE_ROLE },
      });
      return created;
    });

    await this.analytics.track(null, 'workspaces.invitation.sent', { role: WORKSPACE_HIRE_ROLE }, { userId, workspaceId });

    // Приглашённый ещё не член — строка ляжет в «Личное» (контекст по членству адресата).
    if (inv.toUserId) {
      await this.notifications.send(null, {
        type: 'workspace.invitation.received',
        to: [{ userId: inv.toUserId }],
        payload: {
          invitationId: inv.id,
          workspaceId,
          workspaceName: ws.name,
          positionName: inv.position?.name ?? '',
          message: inv.message ?? '',
        },
        workspaceId,
        actorId: userId,
        ref: { type: 'workspace_invitation', id: inv.id },
        reason: 'requested',
        actionUrl: '/dashboard',
        idempotencyKey: `wsi:sent:${inv.id}`,
      });
    }

    const inviter = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    await this.chatter.log(null, {
      refType: 'workspace',
      refId: workspaceId,
      workspaceId,
      actorId: userId,
      actorName: fullNameOrNull(inviter),
      typeKey: 'staff.invited',
      payload: {
        targetUserId: target && !hidden ? target.id : null,
        // Ещё НЕ коллега: имя с инициалом фамилии (пре-линк правило), скрытый — только номер
        targetName: target && !hidden ? [target.firstName, maskLastName(target.lastName)].filter(Boolean).join(' ') : data.phone,
      },
    });
    return (await this.serializeInvitations([{ ...inv, workspace: ws, inviter }], hidden ? new Set([inv.toUserId!]) : undefined))[0];
  }

  async listOutgoingInvitations(userId: string, workspaceId: string): Promise<WorkspaceInvitation[]> {
    await this.assertStaffManage(userId, workspaceId);
    const invs = await this.db.workspaceInvitation.findMany({
      where: { workspaceId, status: 'pending' },
      include: {
        workspace: { select: { name: true, logo: true } },
        inviter: { select: { firstName: true, lastName: true } },
        ...INVITATION_INCLUDE,
      },
      orderBy: { createdAt: 'desc' },
    });
    // Приглашённые, не разрешившие нанимающему находить себя, — без `toUserId` (как незарегистрированные)
    const toIds = invs.map((i) => i.toUserId).filter((x): x is string => !!x);
    const findable = await this.discoverability.filterDiscoverable(toIds, userId);
    return this.serializeInvitations(invs, new Set(toIds.filter((id) => !findable.has(id))));
  }

  async cancelInvitation(userId: string, workspaceId: string, invitationId: string): Promise<void> {
    await this.assertStaffManage(userId, workspaceId);
    const inv = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!inv || inv.workspaceId !== workspaceId) {
      throw notFound('workspace.invitationNotFound');
    }
    if (inv.status !== 'pending') {
      throw badRequest('workspace.invitationHandled');
    }
    // Переход по условию: отмена наперегонки с принятием не должна перезаписать уже
    // принятое приглашение; событие журнала — в той же транзакции
    await this.db.$transaction(async (tx) => {
      const moved = await tx.workspaceInvitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'cancelled', respondedAt: new Date() },
      });
      if (!moved.count) throw badRequest('workspace.invitationHandled');
      await this.audit.record(tx, {
        key: 'org.member.invitation_cancelled',
        workspaceId,
        subjectUserId: inv.toUserId ?? null,
        target: { type: 'workspace_invitation', id: inv.id },
        details: { role: inv.role },
      });
    });
  }

  /** Incoming pending invitations for the current user (dashboard cards). */
  async listIncomingInvitations(userId: string): Promise<WorkspaceInvitation[]> {
    const invs = await this.db.workspaceInvitation.findMany({
      where: { toUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
      include: {
        workspace: { select: { name: true, logo: true } },
        inviter: { select: { firstName: true, lastName: true } },
        ...INVITATION_INCLUDE,
      },
      orderBy: { createdAt: 'desc' },
    });
    return this.serializeInvitations(invs);
  }

  async acceptInvitation(userId: string, invitationId: string): Promise<Workspace | null> {
    const inv = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
      include: { workspace: { select: { id: true, name: true, isActive: true } } },
    });
    if (!inv || inv.toUserId !== userId) {
      throw notFound('workspace.invitationNotFound');
    }
    if (inv.status !== 'pending') {
      throw badRequest('workspace.invitationHandled');
    }
    if (inv.expiresAt <= new Date()) {
      throw badRequest('workspace.invitationExpired');
    }
    if (!inv.workspace.isActive) {
      throw badRequest('workspace.inactive');
    }

    const me = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });

    // All writes in one transaction. The status flip is the atomic guard against a
    // double-accept race (and accept-after-cancel): only the first concurrent call
    // that flips pending→accepted proceeds; the rest see count 0 and bail (rollback).
    await this.db.$transaction(async (tx) => {
      const flipped = await tx.workspaceInvitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      if (flipped.count === 0) {
        throw badRequest('workspace.invitationHandled');
      }

      // Места: считаем В ТРАНЗАКЦИИ под локом строки организации и advisory-локом
      // тарифа — иначе пачка одновременных принятий проезжает мимо предпроверки
      // приглашения. Место занимает член trainee+ (провайдер расхода считает роли).
      const already = await tx.workspaceMember.count({ where: { workspaceId: inv.workspaceId, userId } });
      if (already === 0) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM workspaces WHERE id = ${inv.workspaceId} FOR UPDATE`);
        await this.entitlements.assertCanCreate(tx, { type: 'workspace', id: inv.workspaceId }, 'workspace.seats');
      }
      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } },
        create: { workspaceId: inv.workspaceId, userId },
        update: {},
      });

      // Найм ВСЕГДА в Стажёра — независимо от того, что лежит в старых приглашениях.
      await this.setSoleWorkspaceRoleTx(
        tx,
        userId,
        inv.workspaceId,
        WORKSPACE_HIRE_ROLE,
        inv.invitedBy,
      );

      await this.analytics.track(tx, 'workspaces.invitation.accepted', { role: WORKSPACE_HIRE_ROLE }, { userId, workspaceId: inv.workspaceId });
      // «Вступил» — только про НОВОЕ членство: повторное приглашение действующего члена событием не является
      if (already === 0) {
        await this.webhooks.emit(tx, { workspaceId: inv.workspaceId, eventKey: 'workspaces.member.joined', payload: { userId, role: WORKSPACE_HIRE_ROLE, workspaceId: inv.workspaceId } });
        await this.audit.record(tx, { key: 'org.member.joined', workspaceId: inv.workspaceId, target: { type: 'user', id: userId }, ref: { type: 'workspace_invitation', id: inv.id }, details: { role: WORKSPACE_HIRE_ROLE } });
      }
      await this.chatter.log(tx, {
        refType: 'workspace',
        refId: inv.workspaceId,
        workspaceId: inv.workspaceId,
        actorId: userId,
        actorName: fullNameOrNull(me),
        typeKey: 'staff.hired',
      });

      // Должность «с порога»: назначение со статусом «стажируется» (Додзё этой должности).
      // Несколько филиалов → назначение на каждый (сотрудник обслуживает несколько);
      // без филиалов → одно назначение без филиала.
      if (inv.positionId) {
        const branches = inv.branchIds.length ? inv.branchIds : [null];
        for (const branchId of branches) {
          await this.staff.createAssignmentTx(tx, {
            workspaceId: inv.workspaceId,
            userId,
            positionId: inv.positionId,
            branchId,
            assignedBy: inv.invitedBy,
          });
        }
      }
    });

    // Role rows changed inside the tx → bust this user's cache now.
    await this.roles.invalidateUserCache(userId);
    // Назначение создано в tx (мимо StaffService-проекции) — спроецировать рёбра.
    // Приглашение БЕЗ должности рёбер не добавляет, но состав команды в снимке
    // оргструктуры меняет ВСЕГДА: снимок несёт живые роли (`members`), и без сброса
    // новичок до истечения TTL (15 с процесс / 600 с Redis) «не в организации» —
    // `line` отвечал 404, `manager_of` пустотой, а согласование отказывалось
    // активировать шаг «руководитель» (`empty_assignees`).
    if (inv.positionId) await this.staff.projectWorkspaceStaff(inv.workspaceId);
    else await this.staff.invalidateOrgGraph(inv.workspaceId);

    this.events.emit(
      'workspace.invitation.accepted',
      { workspaceId: inv.workspaceId, workspaceName: inv.workspace.name, inviterId: inv.invitedBy, byName: me ? this.fullName(me) : '', userId },
      'WorkspacesService',
    );
    await this.notifications.send(null, {
      type: 'workspace.invitation.accepted',
      to: [{ userId: inv.invitedBy }],
      payload: { workspaceId: inv.workspaceId, workspaceName: inv.workspace.name, byName: me ? this.fullName(me) : '' },
      workspaceId: inv.workspaceId,
      actorId: userId,
      actionUrl: `/workspaces/${inv.workspaceId}/members`,
      idempotencyKey: `wsi:acc:${inv.id}`,
    });

    const ws = await this.db.workspace.findUnique({
      where: { id: inv.workspaceId },
      include: { _count: { select: { members: true } } },
    });
    return ws ? this.serializeWorkspace(ws, ws._count.members, WORKSPACE_HIRE_ROLE) : null;
  }

  async rejectInvitation(userId: string, invitationId: string): Promise<void> {
    const inv = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
      include: { workspace: { select: { name: true } } },
    });
    if (!inv || inv.toUserId !== userId) {
      throw notFound('workspace.invitationNotFound');
    }
    if (inv.status !== 'pending') {
      throw badRequest('workspace.invitationHandled');
    }
    await this.db.workspaceInvitation.update({
      where: { id: invitationId },
      data: { status: 'rejected', respondedAt: new Date() },
    });

    const me = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    await this.notifications.send(null, {
      type: 'workspace.invitation.rejected',
      to: [{ userId: inv.invitedBy }],
      payload: { workspaceId: inv.workspaceId, workspaceName: inv.workspace.name, byName: me ? this.fullName(me) : '' },
      workspaceId: inv.workspaceId,
      actorId: userId,
      actionUrl: `/workspaces/${inv.workspaceId}/members/invites`,
      idempotencyKey: `wsi:rej:${inv.id}`,
    });
  }

  /**
   * Called from AuthService.register: external workspace invitations (toUserId=null)
   * that targeted this phone are bound to the new user and surfaced as notifications.
   */
  async activatePendingWorkspaceInvitationsForNewUser(userId: string, phone: string): Promise<void> {
    const pending = await this.db.workspaceInvitation.findMany({
      where: { toUserId: null, toPhone: phone, status: 'pending' },
      include: { workspace: { select: { name: true } }, position: { select: { name: true } } },
    });
    if (pending.length === 0) return;

    await this.db.workspaceInvitation.updateMany({
      where: { toUserId: null, toPhone: phone, status: 'pending' },
      data: { toUserId: userId },
    });

    for (const inv of pending) {
      await this.notifications.send(null, {
        type: 'workspace.invitation.received',
        to: [{ userId }],
        payload: {
          invitationId: inv.id,
          workspaceId: inv.workspaceId,
          workspaceName: inv.workspace.name,
          positionName: inv.position?.name ?? '',
          message: inv.message ?? '',
        },
        workspaceId: inv.workspaceId,
        actorId: inv.invitedBy,
        ref: { type: 'workspace_invitation', id: inv.id },
        reason: 'requested',
        actionUrl: '/dashboard',
        idempotencyKey: `wsi:act:${inv.id}`,
      });
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  // Единый источник отображаемого имени — shared/utils/user-name (та же реализация,
  // что и в staff.service; локальная копия разъезжалась бы с ней по фолбэку/маске).
  private fullName(u: UserNameRow): string {
    return fullNameOrNull(u) ?? this.i18n.translate('common.labels.someone');
  }

  private async getWorkspaceOrThrow(workspaceId: string) {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('workspace.notFound');
    return ws;
  }

  /** The user's effective (highest) role in the workspace, or null if not a member. */
  private async getMyRole(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
  }

  private async assertMember(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceRole> {
    const role = await this.getMyRole(userId, workspaceId);
    if (!role) throw forbidden('workspace.noAccess');
    return role;
  }

  private async assertCanManage(userId: string, workspaceId: string) {
    const role = await this.assertMember(userId, workspaceId);
    if (role !== 'owner' && role !== 'admin') {
      throw forbidden('workspace.manageForbidden');
    }
    return role;
  }

  /** Член «команды» (trainee+). Подрядчик изолирован — ростер ему закрыт. */
  private async assertTeamMember(userId: string, workspaceId: string) {
    const role = await this.assertMember(userId, workspaceId);
    if (role === 'contractor') {
      throw forbidden('staff.contractorTasksOnly');
    }
    return role;
  }

  /**
   * Публичный гейт «роль ≥ Менеджер» для СОСЕДНИХ контроллеров этого модуля,
   * которые обслуживают движки (сейчас — «Ссылки организации» на core/share-links).
   * Понятие «роль в организации» принадлежит этому модулю, поэтому движки за ним
   * приходят сюда, а не тянут к себе RolesService.
   */
  async assertManagerPlus(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    return this.assertStaffManage(userId, workspaceId);
  }

  /** Наём и приглашения: Менеджер и выше (управляющий нанимает сам, iiko-модель). */
  private async assertStaffManage(userId: string, workspaceId: string) {
    const role = await this.assertTeamMember(userId, workspaceId);
    if (ROLE_RANK[role] < ROLE_RANK.manager) {
      throw forbidden('staff.managerRequired');
    }
    return role;
  }

  private async assertOwner(userId: string, workspaceId: string) {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    if (ws.ownerId !== userId) {
      throw forbidden('workspace.ownerOnly');
    }
    return ws;
  }

  /** Ensure the user has exactly ONE workspace role (revoke others, assign target). */
  /**
   * Sole workspace role within the given tx: deactivate the user's other active workspace
   * roles and upsert the target role. Does NOT bust the
   * roles cache — the caller MUST call roles.invalidateUserCache(userId) after the tx
   * commits. Used by the atomic create/accept/transfer paths.
   */
  private async setSoleWorkspaceRoleTx(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
    grantedBy: string,
  ) {
    await tx.userRole.updateMany({
      where: {
        userId,
        context: WS_CONTEXT,
        tenantId: workspaceId,
        role: { not: role },
        isActive: true,
      },
      data: { isActive: false },
    });
    await tx.userRole.upsert({
      where: {
        userId_role_context_tenantId: {
          userId,
          role,
          context: WS_CONTEXT,
          tenantId: workspaceId,
        },
      },
      create: { userId, role, context: WS_CONTEXT, tenantId: workspaceId, grantedBy },
      update: { isActive: true, grantedBy },
    });
  }

  /**
   * Уборка следов человека в организации перед снятием доступа (увольнение и выход): должности
   * (+ рёбра доступа и хроника снятия), участия во встречах офиса (доступ к чатам встреч),
   * шаги «Ждут решения» (иначе шаг «нужен каждый» виснет навсегда — решать бывшему члену
   * запрещает гейт). Каждый шаг идемпотентен и идёт ДО `cutMembership`: сбой любого оставляет
   * человека членом с ролями, и повтор проходит путь заново.
   */
  private async releaseMemberFootprint(workspaceId: string, userId: string, actorId: string): Promise<void> {
    await this.staff.removeAllAssignmentsForUser(workspaceId, userId, actorId);
    await this.purgeOfficeParticipations(workspaceId, userId);
    await this.approvals.releaseUserFromWorkspaceSteps(userId, workspaceId);
  }

  /**
   * Снятие доступа к организации — ОДНОЙ транзакцией: строка членства (клейм: параллельный
   * вызов получит 0), все роли организации, личные ключи API и боты человека (каскад core/keys),
   * событие наружу и журнал безопасности. Роли не снимаются отдельно до транзакции: сбой между
   * ними оставил бы человека без ролей, но членом и без следа в журнале, а повтор упёрся бы
   * в «не член». Кэш ролей и снимок оргструктуры — после коммита (транзакционная запись их
   * не сбрасывает). `false` — строку уже снял параллельный вызов.
   */
  private async cutMembership(
    workspaceId: string,
    userId: string,
    p: { exit: 'removed' | 'left'; keysReason: 'removed' | 'left' | 'dismissed'; actorId: string; role: WorkspaceRole | null; hrActionId?: string },
  ): Promise<boolean> {
    const afterKeys = await this.db.$transaction(async (tx) => {
      const gone = await tx.workspaceMember.deleteMany({ where: { workspaceId, userId } });
      if (!gone.count) return null;
      await tx.userRole.updateMany({ where: { userId, context: WS_CONTEXT, tenantId: workspaceId, isActive: true }, data: { isActive: false } });
      // Личные ключи человека в организации гаснут, его боты замораживаются до решения владельца
      const after = await this.keysCascades.onMemberLeft(tx, workspaceId, userId, p.keysReason, p.actorId);
      await this.webhooks.emit(tx, { workspaceId, eventKey: 'workspaces.member.left', payload: { userId, reason: p.exit, workspaceId } });
      const details = p.role ? { role: p.role } : {};
      const target = { type: 'user', id: userId };
      if (p.exit === 'left') {
        await this.audit.record(tx, { key: 'org.member.left', workspaceId, target, details });
      } else if (p.hrActionId) {
        // Увольнение КЭДО применяет система (джоб или чужой запрос, дошедший маршрутом до
        // применения): исполнитель — система, инициатор — автор кадрового действия
        await this.audit.record(tx, {
          key: 'org.member.removed',
          workspaceId,
          target,
          details,
          actor: { kind: 'system', onBehalfOfId: p.actorId },
          ref: { type: 'hr_action', id: p.hrActionId },
        });
      } else {
        await this.audit.record(tx, { key: 'org.member.removed', workspaceId, target, details });
      }
      return after;
    });
    if (!afterKeys) return false;
    await this.roles.invalidateUserCache(userId);
    await afterKeys();
    await this.staff.invalidateOrgGraph(workspaceId);
    return true;
  }

  private async hasMemberRow(workspaceId: string, userId: string): Promise<boolean> {
    return !!(await this.db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { id: true } }));
  }

  /**
   * Замок строки членства в транзакции выдачи роли. Роль без членства — осиротевший доступ:
   * смена роли, стартовавшая до коммита снятия, иначе дождалась бы его и включила роль
   * человеку, которого в организации уже нет. Замок сериализует её со снятием, а после
   * снятия строки нет — отказ.
   */
  private async lockMemberRowTx(tx: Prisma.TransactionClient, workspaceId: string, userId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId} FOR UPDATE`;
    return rows.length > 0;
  }

  /** Одна организация глазами текущего зрителя (анкета — `workspace.card` движка видимости). */
  private async serializeWorkspace(ws: SerializableWorkspace, membersCount: number, myRole?: WorkspaceRole, tasksCount?: number): Promise<Workspace> {
    return (await this.serializeWorkspaces([{ ws, membersCount, myRole, tasksCount }]))[0]!;
  }

  /**
   * Организации глазами текущего зрителя. Анкета (описание, отрасль, город, сайт, контакты,
   * число сотрудников) — правила видимости организации (core/visibility, `workspace.card`,
   * R10: бывший самодельный слой `cardVisibility` и «владелец/админ видят всё»). Имя и лого —
   * пол. Пачка многих организаций — одна проекция (политики по организациям — из кэша).
   */
  private async serializeWorkspaces(
    items: Array<{ ws: SerializableWorkspace; membersCount: number; myRole?: WorkspaceRole; tasksCount?: number }>,
    viewer: VisibilityViewer = this.visibility.viewer('api'),
  ): Promise<Workspace[]> {
    const shaped = await this.visibility.shape(
      viewer,
      'workspace.card',
      items.map(({ ws, membersCount }) => ({
        ref: { recordId: ws.id, subjectId: null, workspaceId: ws.id },
        values: {
          description: ws.description,
          industry: ws.industry,
          city: ws.city,
          website: ws.website,
          contactEmail: ws.contactEmail,
          contactPhone: ws.contactPhone,
          membersCount,
        },
      })),
    );
    return items.map(({ ws, myRole, tasksCount }, i) => {
      const v = shaped[i]!;
      return markShaped({
        id: ws.id,
        name: ws.name,
        logo: ws.logo,
        description: v.description as Workspace['description'],
        industry: v.industry as Workspace['industry'],
        city: v.city as Workspace['city'],
        website: v.website as Workspace['website'],
        contactEmail: v.contactEmail as Workspace['contactEmail'],
        contactPhone: v.contactPhone as Workspace['contactPhone'],
        // Язык бумаг видят все: по нему клиент понимает, на каком языке будет документ
        documentLanguage: coerceLocale(ws.documentLanguage, DEFAULT_DOCUMENT_LANGUAGE),
        ownerId: ws.ownerId,
        membersCount: v.membersCount as Workspace['membersCount'],
        ...(tasksCount !== undefined ? { tasksCount } : {}),
        isActive: ws.isActive,
        // Дату полного удаления считает сервер: срок ретеншна — одна константа, клиенту
        // остаётся показать её и обратный отсчёт.
        ...(ws.archivedAt
          ? {
              archivedAt: ws.archivedAt.toISOString(),
              purgeAt: workspacePurgeAt(ws.archivedAt).toISOString(),
            }
          : {}),
        ...(myRole ? { myRole } : {}),
        createdAt: ws.createdAt.toISOString(),
        updatedAt: ws.updatedAt.toISOString(),
      });
    });
  }

  /**
   * Сериализация приглашений батчем: имена филиалов резолвятся одним запросом по всем
   * branchIds (scalar-массив, FK нет), имя должности приходит из include.
   */
  private async serializeInvitations(
    invs: Array<{
      id: string;
      workspaceId: string;
      invitedBy: string;
      toUserId: string | null;
      toPhone: string;
      role: string;
      positionId: string | null;
      branchIds: string[];
      position?: { name: string } | null;
      message: string | null;
      status: string;
      expiresAt: Date;
      createdAt: Date;
      workspace?: { name: string; logo?: string | null } | null;
      inviter?: UserNameRow | null;
    }>,
    /** Адресаты, которых зритель не находит по номеру: их `toUserId` наружу не едет */
    hideToUserIds?: ReadonlySet<string>,
  ) {
    const allBranchIds = [...new Set(invs.flatMap((i) => i.branchIds))];
    const branchNameById = new Map<string, string>();
    if (allBranchIds.length) {
      const branches = await this.db.staffBranch.findMany({
        where: { id: { in: allBranchIds } },
        select: { id: true, name: true },
      });
      for (const b of branches) branchNameById.set(b.id, b.name);
    }
    return invs.map((inv) => ({
      id: inv.id,
      workspaceId: inv.workspaceId,
      workspaceName: inv.workspace?.name ?? '',
      workspaceLogo: inv.workspace?.logo ?? null,
      invitedBy: inv.invitedBy,
      invitedByName: inv.inviter ? this.fullName(inv.inviter) : '',
      toUserId: inv.toUserId && hideToUserIds?.has(inv.toUserId) ? null : inv.toUserId,
      toPhone: inv.toPhone,
      role: inv.role as WorkspaceRole,
      positionId: inv.positionId,
      positionName: inv.position?.name ?? null,
      branchIds: inv.branchIds,
      branchNames: inv.branchIds.map((id) => branchNameById.get(id)).filter((n): n is string => !!n),
      message: inv.message,
      status: inv.status as 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired',
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
    }));
  }
}

/** Колонки организации, из которых собирается `Workspace` (анкету проецирует движок видимости). */
type SerializableWorkspace = {
  id: string;
  name: string;
  logo: string | null;
  description: string | null;
  industry: string | null;
  city: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  documentLanguage: string;
  ownerId: string;
  isActive: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
