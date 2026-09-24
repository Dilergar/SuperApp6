import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  VISIBILITY_BUS_EVENTS,
  VISIBILITY_ERROR_CODES,
  VISIBILITY_LEVEL_RANK,
  VISIBILITY_LIMITS,
  VISIBILITY_MATRIX_ROLE_COLUMNS,
  VISIBILITY_ORG_AUDIENCE_KINDS,
  VISIBILITY_PRESETS,
  VISIBILITY_APPROVAL_REF_TYPE,
  VISIBILITY_TYPE_KEYS,
  WORKSPACE_ROLE_RANK,
  SOURCE_LOCALE,
  isVisibilityRecordType,
  isVisibilityFieldConfigurable,
  visibilityFieldDefaults,
  visibilityFieldEntry,
  visibilityFieldsOf,
  visibilityGroupsOf,
  visibilityTypeDef,
  type DiscoverableBy,
  type PdFieldCode,
  type PersonalVisibilityDto,
  type PersonalVisibilityInput,
  type VisibilityAudienceRef,
  type VisibilityChangedBusPayload,
  type VisibilityDiffDto,
  type VisibilityDiffEntryDto,
  type VisibilityDraftInput,
  type VisibilityFieldEntry,
  type VisibilityLevel,
  type VisibilityPolicyDto,
  type VisibilityPolicyVersionDto,
  type VisibilityPresetKey,
  type VisibilityPublishResultDto,
  type VisibilityRecordType,
  type VisibilityRuleDto,
  type VisibilityRuleInput,
  type VisibilityTypeMetaDto,
  type VisibilityWorkspaceOverviewDto,
  type WorkspaceRole,
  type WorkspaceVisibilitySettingsDto,
  type WorkspaceVisibilitySettingsInput,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AudiencesService } from '../audiences/audiences.service';
import { ChatterService } from '../chatter/chatter.service';
import { ConsentsActionsService } from '../consents/consents.actions.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RolesService } from '../roles/roles.service';
import { StepUpService } from '../verify/step-up.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { VisibilityCache } from './visibility.cache';
import { compileRules, decideControllerField, type CompiledPolicy, type RowRelation, type RuleRow, type ViewerFacts } from './visibility.plan';
import { VisibilityPersonalGraphRegistry } from './visibility.registry';

type Tx = Prisma.TransactionClient;

const WS = 'workspace';
const PERSONAL_TYPE: VisibilityRecordType = 'user.card';
const NO_REL: RowRelation = { self: false, managerOf: false, branchHead: false, branchPayroll: false, branchScheduler: false, stage: null };

type PolicyWithRules = Prisma.VisibilityPolicyGetPayload<{ include: { rules: true } }>;

/** Столбец матрицы (адресат) для диффа и оценки охвата. */
interface Column {
  kind: VisibilityAudienceRef['kind'];
  id: string | null;
}

/**
 * Политики видимости: черновик организации → дифф → публикация (версии неизменяемы), пресеты,
 * настройки политики; ЛИЧНАЯ политика человека (карточка) — сразу опубликованная, с версией
 * на каждую правку; находимость по номеру; каскады (удаление владельца, разрыв связи,
 * удаление Группы). Публикация бампает версию `pv` в той же транзакции; кэш стирается после
 * коммита — со следующего запроса все процессы видят новую версию.
 */
@Injectable()
export class VisibilityPolicyService {
  private readonly logger = new Logger(VisibilityPolicyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly cache: VisibilityCache,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly audiences: AudiencesService,
    private readonly chatter: ChatterService,
    private readonly consentsActions: ConsentsActionsService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly roles: RolesService,
    private readonly stepUp: StepUpService,
    private readonly events: EventBusService,
    private readonly graph: VisibilityPersonalGraphRegistry,
    private readonly approvals: ApprovalsService,
    private readonly i18n: I18nService,
  ) {}

  // ============================================================
  // Право и мета
  // ============================================================

  async roleIn(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getUserRoles(userId);
    let best: WorkspaceRole | null = null;
    for (const r of roles) {
      if (r.context !== WS || r.tenantId !== workspaceId) continue;
      const rr = r.role as WorkspaceRole;
      if (!(rr in WORKSPACE_ROLE_RANK)) continue;
      if (!best || WORKSPACE_ROLE_RANK[rr] > WORKSPACE_ROLE_RANK[best]) best = rr;
    }
    return best;
  }

  /** Правила организации правят владелец и админ живой организации. Чужому — 404 (не оракул). */
  async assertManager(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.roleIn(userId, workspaceId);
    if (role !== 'owner' && role !== 'admin') throw notFound('workspace.notFound');
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { isActive: true } });
    if (!ws) throw notFound('workspace.notFound');
    if (!ws.isActive) throw forbidden('workspace.inactive');
    return role;
  }

  assertWorkspaceType(recordType: string): VisibilityRecordType {
    const def = visibilityTypeDef(recordType);
    if (!def || def.owner !== 'workspace') throw badRequest(VISIBILITY_ERROR_CODES.unknownRecordType, undefined, { code: VISIBILITY_ERROR_CODES.unknownRecordType });
    return recordType as VisibilityRecordType;
  }

  /** Паспорт типа для UI (матрица, «почему нельзя»). */
  typeMeta(recordType: VisibilityRecordType): VisibilityTypeMetaDto {
    const def = visibilityTypeDef(recordType)!;
    return {
      recordType,
      service: def.service,
      owner: def.owner,
      subject: def.subject,
      sections: Object.keys(def.sections),
      groups: visibilityGroupsOf(recordType),
      floor: [...def.floor],
      stages: [...(def.stages ?? [])],
      fields: visibilityFieldsOf(recordType).map((e) => {
        const d = visibilityFieldDefaults(recordType, e.key);
        const configurable = isVisibilityFieldConfigurable(recordType, e.key);
        return {
          key: e.key,
          section: e.section,
          group: e.def.group,
          class: e.def.class,
          control: e.def.control,
          kind: e.def.kind,
          masks: [...(e.def.masks ?? [])],
          configurable,
          locked: e.def.class === 'secret' ? 'secret' : !configurable ? 'fixed' : null,
          defaults: { ...(d.roles ?? {}) },
          relativeDefaults: { ...(d.relative ?? {}) },
          revealDefault: [...(d.reveal ?? [])],
        };
      }),
    };
  }

  // ============================================================
  // Обзор, политики, черновик
  // ============================================================

  async overview(userId: string, workspaceId: string): Promise<VisibilityWorkspaceOverviewDto> {
    await this.assertManager(userId, workspaceId);
    const types = VISIBILITY_TYPE_KEYS.filter((t) => visibilityTypeDef(t)!.owner === 'workspace');
    const rows = await this.db.visibilityPolicy.findMany({
      where: { ownerType: WS, ownerId: workspaceId, status: { in: ['published', 'draft'] } },
      select: { id: true, recordType: true, version: true, status: true, publishedAt: true, publishedById: true, _count: { select: { rules: true } } },
    });
    const version = (r: (typeof rows)[number]): VisibilityPolicyVersionDto => ({
      id: r.id,
      recordType: r.recordType,
      version: r.version,
      status: r.status as VisibilityPolicyVersionDto['status'],
      publishedAt: r.publishedAt?.toISOString() ?? null,
      publishedById: r.publishedById,
      ruleCount: r._count.rules,
    });
    const [settings, rulesLimit, orgAudiences, revealDelegation] = await Promise.all([
      this.getSettingsRow(workspaceId),
      this.entitlements.limit(userId, 'visibility.maxRules', { type: 'workspace', id: workspaceId }),
      this.entitlements.can(userId, 'visibility.orgAudiences', { type: 'workspace', id: workspaceId }),
      this.entitlements.can(userId, 'visibility.revealDelegation', { type: 'workspace', id: workspaceId }),
    ]);
    return {
      types: types.map((t) => this.typeMeta(t)),
      policies: types.map((t) => ({
        recordType: t,
        published: (() => {
          const r = rows.find((x) => x.recordType === t && x.status === 'published');
          return r ? version(r) : null;
        })(),
        draft: (() => {
          const r = rows.find((x) => x.recordType === t && x.status === 'draft');
          return r ? version(r) : null;
        })(),
      })),
      settings,
      rulesUsed: rows.reduce((s, r) => s + r._count.rules, 0),
      rulesLimit,
      features: { orgAudiences, revealDelegation },
    };
  }

  async getPolicy(userId: string, workspaceId: string, recordType: string, status: 'published' | 'draft'): Promise<VisibilityPolicyDto | null> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const row = await this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status }, include: { rules: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] } } });
    return row ? this.toDto(row) : null;
  }

  /**
   * Автосейв черновика: правила ЗАМЕНЯЮТСЯ целиком (черновик = набор строк). `baseToken` —
   * оптимистичная блокировка: вкладка, правившая старую версию черновика, получит 409, а не
   * затрёт чужую правку. Черновика нет — создаётся из опубликованной версии.
   */
  async saveDraft(userId: string, workspaceId: string, recordType: string, input: VisibilityDraftInput): Promise<VisibilityPolicyDto> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const rules = await this.validateRules(userId, workspaceId, type, input.rules);
    const row = await this.db.$transaction(async (tx) => {
      await this.lock(tx, workspaceId, type);
      const draft = await this.ensureDraft(tx, userId, workspaceId, type, null);
      if (input.baseToken && draft.draftToken && input.baseToken !== draft.draftToken) {
        throw conflict(VISIBILITY_ERROR_CODES.draftChanged, undefined, { code: VISIBILITY_ERROR_CODES.draftChanged });
      }
      const before = await tx.visibilityRule.count({ where: { policyId: draft.id } });
      if (rules.length > before) await this.entitlements.assertCanCreate(tx, { type: 'workspace', id: workspaceId }, 'visibility.maxRules', rules.length - before);
      await tx.visibilityRule.deleteMany({ where: { policyId: draft.id } });
      if (rules.length) await tx.visibilityRule.createMany({ data: rules.map((r, i) => ({ ...this.ruleData(r, i), policyId: draft.id })) });
      await tx.visibilityPolicy.update({ where: { id: draft.id }, data: { draftToken: randomUUID() } });
      return tx.visibilityPolicy.findUniqueOrThrow({ where: { id: draft.id }, include: { rules: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] } } });
    });
    return this.toDto(row);
  }

  /** Пресет → ЧЕРНОВИК каждого затронутого типа: опубликованные правила + правила пресета поверх (та же цель и адресат — пресет). */
  async applyPreset(userId: string, workspaceId: string, preset: VisibilityPresetKey): Promise<VisibilityPolicyDto[]> {
    await this.assertManager(userId, workspaceId);
    await this.entitlements.assertFeature(userId, 'visibility.presets', { type: 'workspace', id: workspaceId });
    const byType = new Map<string, VisibilityRuleInput[]>();
    for (const r of VISIBILITY_PRESETS[preset]) {
      const list = byType.get(r.recordType) ?? [];
      list.push({ fieldKey: r.fieldKey ?? null, groupKey: (r.groupKey as VisibilityRuleInput['groupKey']) ?? null, sectionKey: null, audience: r.audience as VisibilityRuleInput['audience'], effect: r.effect, level: r.level, mask: r.mask ?? null, reveal: r.reveal ?? 'none' });
      byType.set(r.recordType, list);
    }
    const out: VisibilityPolicyDto[] = [];
    for (const [type, presetRules] of byType) {
      const published = await this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'published' }, include: { rules: true } });
      const base: VisibilityRuleInput[] = (published?.rules ?? []).map((r) => this.ruleInputOf(r));
      const key = (r: VisibilityRuleInput) => `${r.fieldKey ?? ''}|${r.groupKey ?? ''}|${r.sectionKey ?? ''}|${r.audience.kind}|${r.audience.id ?? ''}|${r.stage ?? ''}`;
      const merged = new Map(base.map((r) => [key(r), r]));
      for (const r of presetRules) merged.set(key(r), r);
      const dto = await this.saveDraft(userId, workspaceId, type, { rules: [...merged.values()] });
      await this.db.visibilityPolicy.update({ where: { id: dto.id }, data: { presetKey: preset } });
      out.push({ ...dto, presetKey: preset });
    }
    return out;
  }

  async discardDraft(userId: string, workspaceId: string, recordType: string): Promise<void> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const res = await this.db.visibilityPolicy.deleteMany({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'draft' } });
    if (res.count === 0) throw badRequest(VISIBILITY_ERROR_CODES.draftMissing, undefined, { code: VISIBILITY_ERROR_CODES.draftMissing });
  }

  /** «Вернуть эту версию» = новый черновик с правилами той версии. */
  async restoreVersion(userId: string, workspaceId: string, recordType: string, version: number): Promise<VisibilityPolicyDto> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const src = await this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, version, status: { in: ['published', 'archived'] } }, include: { rules: true } });
    if (!src) throw notFound(VISIBILITY_ERROR_CODES.recordNotFound, undefined, { code: VISIBILITY_ERROR_CODES.recordNotFound });
    return this.saveDraft(userId, workspaceId, type, { rules: src.rules.map((r) => this.ruleInputOf(r)) });
  }

  async versions(userId: string, workspaceId: string, recordType: string): Promise<VisibilityPolicyVersionDto[]> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const rows = await this.db.visibilityPolicy.findMany({
      where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: { in: ['published', 'archived'] } },
      orderBy: { version: 'desc' },
      take: VISIBILITY_LIMITS.versionsPageSize,
      select: { id: true, recordType: true, version: true, status: true, publishedAt: true, publishedById: true, _count: { select: { rules: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      recordType: r.recordType,
      version: r.version,
      status: r.status as VisibilityPolicyVersionDto['status'],
      publishedAt: r.publishedAt?.toISOString() ?? null,
      publishedById: r.publishedById,
      ruleCount: r._count.rules,
    }));
  }

  // ============================================================
  // Дифф и публикация
  // ============================================================

  async diff(userId: string, workspaceId: string, recordType: string): Promise<VisibilityDiffDto> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const [draft, published] = await Promise.all([
      this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'draft' }, include: { rules: true } }),
      this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'published' }, include: { rules: true } }),
    ]);
    if (!draft) throw badRequest(VISIBILITY_ERROR_CODES.draftMissing, undefined, { code: VISIBILITY_ERROR_CODES.draftMissing });
    return this.computeDiff(workspaceId, type, draft, published);
  }

  private async computeDiff(workspaceId: string, type: VisibilityRecordType, draft: PolicyWithRules, published: PolicyWithRules | null): Promise<VisibilityDiffDto> {
    const before: CompiledPolicy = { pv: published?.version ?? 0, rules: compileRules(type, published?.rules ?? []) };
    const after: CompiledPolicy = { pv: draft.version, rules: compileRules(type, draft.rules) };
    const def = visibilityTypeDef(type)!;
    const columns: Column[] = [
      ...VISIBILITY_MATRIX_ROLE_COLUMNS.map((r) => ({ kind: 'role' as const, id: r })),
      ...(def.subject === 'user' ? [{ kind: 'manager_of' as const, id: null }] : []),
      { kind: 'branch_head_of', id: null },
      { kind: 'branch_payroll', id: null },
      { kind: 'branch_scheduler', id: null },
    ];
    const seen = new Set(columns.map((c) => `${c.kind}:${c.id ?? ''}`));
    for (const r of [...before.rules, ...after.rules]) {
      const k = `${r.audienceKind}:${r.audienceId ?? ''}`;
      if (!seen.has(k) && (VISIBILITY_ORG_AUDIENCE_KINDS as readonly string[]).includes(r.audienceKind)) {
        seen.add(k);
        columns.push({ kind: r.audienceKind, id: r.audienceId });
      }
    }
    const widened: VisibilityDiffEntryDto[] = [];
    const narrowed: VisibilityDiffEntryDto[] = [];
    let weakensRestricted = false;
    const widenedCols = new Set<string>();
    const narrowedCols = new Set<string>();
    for (const e of visibilityFieldsOf(type)) {
      for (const col of columns) {
        const b = this.columnDecision(type, e, before, col);
        const a = this.columnDecision(type, e, after, col);
        const bRank = VISIBILITY_LEVEL_RANK[b.level] * 2 + (b.reveal === 'one' ? 1 : 0);
        const aRank = VISIBILITY_LEVEL_RANK[a.level] * 2 + (a.reveal === 'one' ? 1 : 0);
        if (aRank === bRank) continue;
        const entry: VisibilityDiffEntryDto = { fieldKey: e.key, audience: { kind: col.kind, id: col.id }, from: b.level, to: a.level };
        if (aRank > bRank) {
          widened.push(entry);
          widenedCols.add(`${col.kind}:${col.id ?? ''}`);
          if (e.def.class === 'restricted' || e.def.class === 'secret') weakensRestricted = true;
        } else {
          narrowed.push(entry);
          narrowedCols.add(`${col.kind}:${col.id ?? ''}`);
        }
      }
    }
    const [widenPeople, narrowPeople] = await Promise.all([this.columnPeople(workspaceId, widenedCols), this.columnPeople(workspaceId, narrowedCols)]);
    return {
      recordType: type,
      draftVersion: draft.version,
      baseVersion: published?.version ?? null,
      draftToken: draft.draftToken ?? '',
      widened,
      narrowed,
      widenPeople,
      narrowPeople,
      weakensRestricted,
      mandatoryViolations: this.mandatoryViolations(type, after),
    };
  }

  /** Решение для «синтетического зрителя одного столбца» — тот же расчёт, что у живых людей. */
  private columnDecision(type: VisibilityRecordType, e: VisibilityFieldEntry, policy: CompiledPolicy, col: Column) {
    const facts: ViewerFacts = {
      kind: 'user',
      userId: '00000000-0000-4000-8000-000000000000',
      role: col.kind === 'role' ? (col.id as WorkspaceRole) : null,
      principals: new Set(col.kind === 'department' || col.kind === 'position' || col.kind === 'branch' ? [`${col.kind}:${col.id}`] : []),
      botContactAccess: false,
      purpose: 'explain',
      revealDelegation: true,
    };
    const rel: RowRelation = { ...NO_REL, managerOf: col.kind === 'manager_of', branchHead: col.kind === 'branch_head_of', branchPayroll: col.kind === 'branch_payroll', branchScheduler: col.kind === 'branch_scheduler' };
    return decideControllerField(type, e, policy, facts, rel);
  }

  /** Сколько людей организации в столбцах (оценка охвата диффа). Относительные столбцы не считаются. */
  private async columnPeople(workspaceId: string, cols: Set<string>): Promise<number> {
    const ids = new Set<string>();
    const roles = [...cols].filter((c) => c.startsWith('role:')).map((c) => c.slice(5));
    if (roles.length) {
      const rows = await this.db.userRole.findMany({ where: { context: WS, tenantId: workspaceId, isActive: true, role: { in: roles } }, select: { userId: true } });
      for (const r of rows) ids.add(r.userId);
    }
    const org = [...cols].filter((c) => /^(department|position|branch):/.test(c));
    for (const c of org) {
      const [kind, id] = c.split(':') as [string, string];
      const users = await this.audiences
        .resolve([{ type: kind as 'department', id }], { workspaceId }, { max: 5000, onOverflow: 'truncate' })
        .catch(() => [] as string[]);
      for (const u of users) ids.add(u);
    }
    return ids.size;
  }

  /** Обязательная видимость: `legalDuty` — хоть один столбец `full`; `mandatoryVisible: owner` — владелец видит. */
  private mandatoryViolations(type: VisibilityRecordType, policy: CompiledPolicy): string[] {
    const out: string[] = [];
    for (const e of visibilityFieldsOf(type)) {
      const must = e.def.mandatoryVisible ?? [];
      if (must.includes('owner')) {
        const d = this.columnDecision(type, e, policy, { kind: 'role', id: 'owner' });
        if (d.level === 'hidden') out.push(e.key);
      }
      if (e.def.legalDuty) {
        const anyFull = VISIBILITY_MATRIX_ROLE_COLUMNS.some((r) => this.columnDecision(type, e, policy, { kind: 'role', id: r }).level === 'full');
        if (!anyFull) out.push(e.key);
      }
    }
    return [...new Set(out)];
  }

  /**
   * Публикация: публикуется РОВНО то, что показал дифф (`draftToken`). Обязательная видимость
   * нарушена → 400; ослабление строгих полей или выдача делегирования раскрытия — окно
   * «сильного подтверждения» (`visibility_manage`); при «четырёх глазах» — заявка второму
   * админу (публикует его одобрение). Версия, журнал, хроника, аналитика, уведомление
   * админам — одной транзакцией; кэш и сокет — после коммита.
   */
  async publish(userId: string, workspaceId: string, recordType: string, draftToken: string): Promise<VisibilityPublishResultDto> {
    await this.assertManager(userId, workspaceId);
    const type = this.assertWorkspaceType(recordType);
    const [draft, published] = await Promise.all([
      this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'draft' }, include: { rules: true } }),
      this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'published' }, include: { rules: true } }),
    ]);
    if (!draft) throw badRequest(VISIBILITY_ERROR_CODES.draftMissing, undefined, { code: VISIBILITY_ERROR_CODES.draftMissing });
    if (!draft.draftToken || draft.draftToken !== draftToken) throw conflict(VISIBILITY_ERROR_CODES.draftChanged, undefined, { code: VISIBILITY_ERROR_CODES.draftChanged });
    const diff = await this.computeDiff(workspaceId, type, draft, published);
    if (diff.mandatoryViolations.length) {
      throw badRequest(VISIBILITY_ERROR_CODES.mandatoryViolation, undefined, { code: VISIBILITY_ERROR_CODES.mandatoryViolation, fields: diff.mandatoryViolations });
    }
    const grantsDelegation = draft.rules.some((r) => r.reveal === 'delegated') && !(published?.rules ?? []).some((r) => r.reveal === 'delegated');
    if (grantsDelegation) await this.entitlements.assertFeature(userId, 'visibility.revealDelegation', { type: 'workspace', id: workspaceId });
    if (diff.weakensRestricted || grantsDelegation) await this.stepUp.assert(userId, 'visibility_manage');
    const settings = await this.getSettingsRow(workspaceId);
    if (settings.dualControl && diff.weakensRestricted) {
      // «Четыре глаза»: ослабление строгих полей публикует не автор, а одобрение ДРУГОГО
      // владельца/админа (core/approvals). Решение привязано к отпечатку правил черновика
      return { status: 'pending_approval', approvalId: await this.requestPublishApproval(userId, workspaceId, draft.id, draftToken) };
    }
    return { status: 'published', policy: await this.publishTx(userId, workspaceId, type, draft.id, draftToken, diff, grantsDelegation) };
  }

  /** Заявка второму владельцу/админу на публикацию черновика (ведущий — этот сервис). */
  private async requestPublishApproval(userId: string, workspaceId: string, draftId: string, draftToken: string): Promise<string> {
    const managers = await this.audiences
      .resolve([{ type: 'workspace', id: workspaceId }], { workspaceId }, { max: 50, onOverflow: 'truncate', roles: ['owner', 'admin'] })
      .catch(() => [] as string[]);
    const approvers = managers.filter((id) => id !== userId);
    if (!approvers.length) throw conflict(VISIBILITY_ERROR_CODES.noSecondAdmin, undefined, { code: VISIBILITY_ERROR_CODES.noSecondAdmin });
    const approval = await this.approvals.create(
      userId,
      {
        refType: VISIBILITY_APPROVAL_REF_TYPE,
        refId: draftId,
        steps: approvers.map((id) => ({ order: 0, kind: 'approval' as const, assigneeType: 'user' as const, assigneeId: id, rule: 'any' as const })),
      },
      { type: VISIBILITY_APPROVAL_REF_TYPE, ref: `${draftId}:${draftToken}:${userId}` },
    );
    return approval.id;
  }

  /** Контекст заявки: черновик жив, автор вправе править политику; отпечаток — правила черновика. */
  async describePublishApproval(userId: string, draftId: string): Promise<{ title: string; workspaceId: string; contentSha256: string } | null> {
    const draft = await this.db.visibilityPolicy.findFirst({ where: { id: draftId, ownerType: WS, status: 'draft' }, include: { rules: true } });
    if (!draft) return null;
    const role = await this.roleIn(userId, draft.ownerId);
    if (role !== 'owner' && role !== 'admin') return null;
    return {
      title: this.i18n.translateFor(SOURCE_LOCALE, 'visibility.approval.title', { type: this.i18n.translateFor(SOURCE_LOCALE, typeTitleKey(draft.recordType)) }),
      workspaceId: draft.ownerId,
      contentSha256: rulesFingerprint(draft.rules),
    };
  }

  /** Одобрено — публикуем ровно тот черновик (токен тот же), от имени автора заявки. */
  async onPublishApprovalResolved(originRef: string, outcome: 'approved' | 'rejected' | 'returned'): Promise<void> {
    if (outcome !== 'approved') return;
    const [draftId, draftToken, requesterId] = originRef.split(':');
    if (!draftId || !draftToken || !requesterId) return;
    const draft = await this.db.visibilityPolicy.findFirst({ where: { id: draftId, ownerType: WS, status: 'draft', draftToken }, include: { rules: true } });
    // Черновик правили после заявки — одобрение относилось к другим правилам: не публикуем
    if (!draft || !isVisibilityRecordType(draft.recordType)) return;
    // Автор заявки к моменту одобрения обязан оставаться владельцем/админом ЖИВОЙ организации:
    // одобрение — это «второй глаз», а не право публиковать от имени того, кого уже сняли
    const requesterRole = await this.roleIn(requesterId, draft.ownerId);
    const ws = await this.db.workspace.findUnique({ where: { id: draft.ownerId }, select: { isActive: true } });
    if ((requesterRole !== 'owner' && requesterRole !== 'admin') || !ws?.isActive) {
      this.logger.warn(`visibility publish approval for draft ${draftId} skipped: requester is no longer a manager`);
      return;
    }
    const type = draft.recordType as VisibilityRecordType;
    const published = await this.db.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: draft.ownerId, recordType: type, status: 'published' }, include: { rules: true } });
    const diff = await this.computeDiff(draft.ownerId, type, draft, published);
    if (diff.mandatoryViolations.length) return;
    const grantsDelegation = draft.rules.some((r) => r.reveal === 'delegated') && !(published?.rules ?? []).some((r) => r.reveal === 'delegated');
    await this.publishTx(requesterId, draft.ownerId, type, draft.id, draftToken, diff, grantsDelegation);
  }

  /** Исполнение публикации (зовёт и одобрение «четырёх глаз» — от имени одобрившего). */
  async publishTx(actorId: string, workspaceId: string, type: VisibilityRecordType, draftId: string, draftToken: string, diff: VisibilityDiffDto, grantsDelegation: boolean): Promise<VisibilityPolicyDto> {
    const row = await this.db.$transaction(async (tx) => {
      await this.lock(tx, workspaceId, type);
      // Сначала прежняя версия — в архив: частичный уникум «одна опубликованная» проверяется на
      // КАЖДОМ операторе, и черновик, ставший published рядом с живой версией, падал 23505.
      // Черновик не тот (правили после диффа) — исключение ниже откатит и этот шаг.
      await tx.visibilityPolicy.updateMany({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'published', id: { not: draftId } }, data: { status: 'archived' } });
      // Статус-гвард: черновик тот же и не менялся с диффа
      const claimed = await tx.visibilityPolicy.updateMany({
        where: { id: draftId, status: 'draft', draftToken },
        data: { status: 'published', publishedAt: new Date(), publishedById: actorId, draftToken: null },
      });
      if (claimed.count === 0) throw conflict(VISIBILITY_ERROR_CODES.draftChanged, undefined, { code: VISIBILITY_ERROR_CODES.draftChanged });
      const pub = await tx.visibilityPolicy.findUniqueOrThrow({ where: { id: draftId }, include: { rules: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] } } });
      await this.audit.record(tx, {
        key: 'org.visibility.policy_published',
        workspaceId,
        target: { type: 'visibility_policy', id: pub.id },
        details: { recordType: type, version: pub.version, widened: diff.widened.length, narrowed: diff.narrowed.length, weakensRestricted: diff.weakensRestricted, revealDelegated: grantsDelegation },
      });
      await this.chatter.log(tx, {
        refType: 'visibility_policy',
        refId: workspaceId,
        workspaceId,
        actorId,
        typeKey: 'visibility_policy.published',
        payload: { recordType: type, typeLabelKey: typeTitleKey(type), version: pub.version },
      });
      await this.analytics.track(tx, 'visibility.policy.published', { recordType: type, rules: pub.rules.length, fromPreset: !!pub.presetKey }, { workspaceId });
      const admins = await this.audiences.resolve([{ type: 'workspace', id: workspaceId }], { workspaceId }, { max: 50, onOverflow: 'truncate', roles: ['owner', 'admin'] }).catch(() => [] as string[]);
      if (admins.length) {
        await this.notifications.send(tx, {
          type: 'visibility.policy.published',
          to: admins.map((id) => ({ userId: id })),
          actorId,
          workspaceId,
          ref: { type: 'visibility_policy', id: workspaceId },
          payload: { recordType: type, recordTypeLabelKey: typeTitleKey(type), version: pub.version },
        });
      }
      return pub;
    });
    await this.afterChange('workspace', workspaceId, [type], row.version);
    return this.toDto(row);
  }

  // ============================================================
  // Настройки политики организации (R18) — правит только владелец
  // ============================================================

  private async getSettingsRow(workspaceId: string): Promise<WorkspaceVisibilitySettingsDto> {
    const s = await this.db.workspaceVisibilitySettings.findUnique({ where: { workspaceId } });
    return { notifyOnReveal: !!s?.notifyOnReveal, dualControl: !!s?.dualControl, allowDelegation: !!s?.allowDelegation, updatedAt: s?.updatedAt.toISOString() ?? null };
  }

  async getSettings(userId: string, workspaceId: string): Promise<WorkspaceVisibilitySettingsDto> {
    await this.assertManager(userId, workspaceId);
    return this.getSettingsRow(workspaceId);
  }

  async updateSettings(userId: string, workspaceId: string, input: WorkspaceVisibilitySettingsInput): Promise<WorkspaceVisibilitySettingsDto> {
    const role = await this.assertManager(userId, workspaceId);
    if (role !== 'owner') throw forbidden('visibility.owner_only', undefined, { code: 'visibility.owner_only' });
    const current = await this.getSettingsRow(workspaceId);
    const next = {
      notifyOnReveal: input.notifyOnReveal ?? current.notifyOnReveal,
      dualControl: input.dualControl ?? current.dualControl,
      allowDelegation: input.allowDelegation ?? current.allowDelegation,
    };
    if (next.allowDelegation && !current.allowDelegation) {
      await this.entitlements.assertFeature(userId, 'visibility.revealDelegation', { type: 'workspace', id: workspaceId });
      // Выдача права раскрывать — под SMS (решение грилла №7)
      await this.stepUp.assert(userId, 'visibility_manage');
    }
    // Ослабление контроля (снять «четыре глаза») — тоже под SMS
    if (!next.dualControl && current.dualControl) await this.stepUp.assert(userId, 'visibility_manage');
    await this.db.$transaction(async (tx) => {
      await tx.workspaceVisibilitySettings.upsert({
        where: { workspaceId },
        create: { workspaceId, ...next, updatedById: userId },
        update: { ...next, updatedById: userId },
      });
      await this.audit.record(tx, { key: 'org.visibility.settings_changed', workspaceId, details: next });
    });
    return this.getSettingsRow(workspaceId);
  }

  // ============================================================
  // Личная политика человека («Моя карточка и видимость»)
  // ============================================================

  async personalGet(userId: string): Promise<PersonalVisibilityDto> {
    const [row, user] = await Promise.all([
      this.db.visibilityPolicy.findFirst({ where: { ownerType: 'user', ownerId: userId, recordType: PERSONAL_TYPE, status: 'published' }, include: { rules: true } }),
      this.db.user.findUnique({ where: { id: userId }, select: { discoverableBy: true } }),
    ]);
    const rules = row?.rules ?? [];
    const fields = visibilityFieldsOf(PERSONAL_TYPE)
      .filter((e) => isVisibilityFieldConfigurable(PERSONAL_TYPE, e.key))
      .map((e) => {
        const own = rules.filter((r) => r.fieldKey === e.key);
        const isGroupHide = (r: (typeof own)[number]) => r.audienceKind === 'circle' && r.effect === 'deny';
        const configured = own.some((r) => r.audienceKind !== 'user' && !isGroupHide(r));
        const audiences: VisibilityAudienceRef[] = configured
          ? own.filter((r) => r.effect === 'allow' && r.audienceKind !== 'user').map((r) => ({ kind: r.audienceKind as VisibilityAudienceRef['kind'], id: r.audienceId }))
          : (visibilityFieldDefaults(PERSONAL_TYPE, e.key).audiences ?? []).map((k) => ({ kind: k, id: null }));
        return {
          fieldKey: e.key,
          audiences,
          always: own.filter((r) => r.audienceKind === 'user' && r.effect === 'allow' && r.audienceId).map((r) => r.audienceId!),
          never: own.filter((r) => r.audienceKind === 'user' && r.effect === 'deny' && r.audienceId).map((r) => r.audienceId!),
          hiddenFromCircles: own.filter((r) => isGroupHide(r) && r.audienceId).map((r) => r.audienceId!),
          configured,
        };
      });
    return { pv: row?.version ?? 0, fields, discoverableBy: (user?.discoverableBy as DiscoverableBy) ?? 'everybody' };
  }

  /**
   * Правка «кто видит» полей своей карточки. Затронутые поля заменяются целиком (аудитории +
   * исключения), остальные не трогаются. Проверки: Группы — свои, организации — где человек в
   * команде, исключения — живые люди, не сам, без конфликта «всегда/никогда». Перевод поля в
   * «Все» — распространение по действию субъекта (учёт `pd.publication`, R20).
   */
  async personalUpdate(userId: string, input: PersonalVisibilityInput): Promise<PersonalVisibilityDto> {
    const keys = new Set<string>();
    for (const f of input.fields) {
      const e = visibilityFieldEntry(PERSONAL_TYPE, f.fieldKey);
      if (!e || e.def.control !== 'subject' || !isVisibilityFieldConfigurable(PERSONAL_TYPE, f.fieldKey)) {
        throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid, fieldKey: f.fieldKey });
      }
      if (keys.has(f.fieldKey)) throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid, fieldKey: f.fieldKey });
      keys.add(f.fieldKey);
      if (f.audiences.length + (f.always?.length ?? 0) + (f.never?.length ?? 0) > VISIBILITY_LIMITS.maxAudiencesPerField + VISIBILITY_LIMITS.maxExceptionsPerField) {
        throw badRequest(VISIBILITY_ERROR_CODES.tooManyAudiences, undefined, { code: VISIBILITY_ERROR_CODES.tooManyAudiences });
      }
      const never = new Set(f.never ?? []);
      if ((f.always ?? []).some((id) => never.has(id))) throw badRequest(VISIBILITY_ERROR_CODES.exceptionConflict, undefined, { code: VISIBILITY_ERROR_CODES.exceptionConflict });
    }
    // Группы — только свои (и в аудиториях, и в «скрыть от Группы»)
    const circleIds = [
      ...new Set(input.fields.flatMap((f) => [...f.audiences.filter((a) => a.kind === 'circle').map((a) => a.id!), ...(f.hiddenFromCircles ?? [])])),
    ];
    if (circleIds.length) {
      const own = new Set(await this.graph.get()?.circleIdsOwnedBy(userId) ?? []);
      if (circleIds.some((id) => !own.has(id))) throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid });
    }
    // Коллеги конкретной организации — только там, где человек в команде
    const wsIds = [...new Set(input.fields.flatMap((f) => f.audiences.filter((a) => a.kind === 'colleagues' && a.id).map((a) => a.id!)))];
    if (wsIds.length) {
      const mine = new Set((await this.roles.getUserRoles(userId)).filter((r) => r.context === WS && r.role !== 'contractor' && r.tenantId).map((r) => r.tenantId!));
      if (wsIds.some((id) => !mine.has(id))) throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid });
    }
    // Исключения — живые люди, не сам
    const people = [...new Set(input.fields.flatMap((f) => [...(f.always ?? []), ...(f.never ?? [])]))];
    if (people.includes(userId)) throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid });
    if (people.length) {
      const alive = await this.db.user.count({ where: { id: { in: people }, deletedAt: null } });
      if (alive !== people.length) throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid });
    }

    const before = await this.personalGet(userId);
    const wasEverybody = new Set(before.fields.filter((f) => f.audiences.some((a) => a.kind === 'everybody')).map((f) => f.fieldKey));
    let version = 0;
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, userId, PERSONAL_TYPE);
      const policy = await this.ensurePersonal(tx, userId);
      await tx.visibilityRule.deleteMany({ where: { policyId: policy.id, fieldKey: { in: [...keys] } } });
      const data: Prisma.VisibilityRuleCreateManyInput[] = [];
      for (const f of input.fields) {
        if (!f.audiences.length) data.push({ policyId: policy.id, fieldKey: f.fieldKey, audienceKind: 'everybody', audienceId: null, effect: 'deny', level: 'hidden', reveal: 'none' });
        for (const a of f.audiences) data.push({ policyId: policy.id, fieldKey: f.fieldKey, audienceKind: a.kind, audienceId: a.id ?? null, effect: 'allow', level: 'full', reveal: 'none' });
        for (const id of new Set(f.always ?? [])) data.push({ policyId: policy.id, fieldKey: f.fieldKey, audienceKind: 'user', audienceId: id, effect: 'allow', level: 'full', reveal: 'none' });
        for (const id of new Set(f.never ?? [])) data.push({ policyId: policy.id, fieldKey: f.fieldKey, audienceKind: 'user', audienceId: id, effect: 'deny', level: 'hidden', reveal: 'none' });
        for (const id of new Set(f.hiddenFromCircles ?? [])) data.push({ policyId: policy.id, fieldKey: f.fieldKey, audienceKind: 'circle', audienceId: id, effect: 'deny', level: 'hidden', reveal: 'none' });
      }
      if (data.length) await tx.visibilityRule.createMany({ data });
      const updated = await tx.visibilityPolicy.update({ where: { id: policy.id }, data: { version: { increment: 1 }, publishedAt: new Date(), publishedById: userId } });
      version = updated.version;
      const nowEverybody = input.fields.filter((f) => f.audiences.some((a) => a.kind === 'everybody') && !wasEverybody.has(f.fieldKey)).map((f) => f.fieldKey);
      if (nowEverybody.length) {
        // Распространение по действию самого субъекта (ЗоПД ст. 24; R20): факт, не значения
        await this.consentsActions.record(tx, { subjectId: userId, actionType: 'publication', basis: 'subject_action', fields: [...new Set(nowEverybody.map(pdFieldOf))], purpose: 'card_visibility_changed', refType: 'user', refId: userId });
      }
      await this.analytics.track(tx, 'visibility.personal.changed', { fields: input.fields.length, widened: nowEverybody.length > 0 }, {});
    });
    await this.afterChange('user', userId, [PERSONAL_TYPE], version);
    return this.personalGet(userId);
  }

  /**
   * Редактор Группы (`/circles`, быстрый путь «этой Группе показать / скрыть»): по полю
   * `true` — Группа в аудиториях поля (умолчания поля при этом материализуются, иначе
   * первый же тумблер отнимал бы поле у всего Окружения), `false` — «скрыть от Группы»,
   * `null` — как задано в карточке. Остальные настройки поля не трогаются.
   */
  async setCircleFields(userId: string, circleId: string, fields: Record<string, boolean | null>): Promise<PersonalVisibilityDto> {
    const own = new Set((await this.graph.get()?.circleIdsOwnedBy(userId)) ?? []);
    if (!own.has(circleId)) throw notFound('contacts.circleNotFound');
    const current = await this.personalGet(userId);
    const next: PersonalVisibilityInput['fields'] = [];
    for (const [fieldKey, value] of Object.entries(fields)) {
      const f = current.fields.find((x) => x.fieldKey === fieldKey);
      if (!f) throw badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid, fieldKey });
      const audiences = f.audiences.filter((a) => !(a.kind === 'circle' && a.id === circleId));
      const hidden = f.hiddenFromCircles.filter((c) => c !== circleId);
      if (value === true) audiences.push({ kind: 'circle', id: circleId });
      if (value === false) hidden.push(circleId);
      next.push({
        fieldKey,
        audiences: audiences as PersonalVisibilityInput['fields'][number]['audiences'],
        always: f.always,
        never: f.never,
        hiddenFromCircles: hidden,
      });
    }
    return this.personalUpdate(userId, { fields: next });
  }

  /** Сбросить поля к умолчаниям платформы. */
  async personalReset(userId: string, fieldKeys: readonly string[]): Promise<PersonalVisibilityDto> {
    let version = 0;
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, userId, PERSONAL_TYPE);
      const policy = await tx.visibilityPolicy.findFirst({ where: { ownerType: 'user', ownerId: userId, recordType: PERSONAL_TYPE, status: 'published' } });
      if (!policy) return;
      await tx.visibilityRule.deleteMany({ where: { policyId: policy.id, fieldKey: { in: [...fieldKeys] } } });
      version = (await tx.visibilityPolicy.update({ where: { id: policy.id }, data: { version: { increment: 1 } } })).version;
    });
    if (version) await this.afterChange('user', userId, [PERSONAL_TYPE], version);
    return this.personalGet(userId);
  }

  async setDiscoverability(userId: string, value: DiscoverableBy): Promise<PersonalVisibilityDto> {
    await this.db.user.update({ where: { id: userId }, data: { discoverableBy: value } });
    return this.personalGet(userId);
  }

  // ============================================================
  // Каскады (R1, R2)
  // ============================================================

  /**
   * Окончательное удаление владельца (организация — каскад `purgeWorkspace`; человек —
   * анонимизация аккаунта): политики без внешнего ключа иначе пережили бы его навсегда.
   * Идемпотентно. Кэш — после коммита вызывающего (здесь best-effort сразу).
   */
  async purgeOwner(tx: Tx | null, ownerKind: 'workspace' | 'user', ownerId: string): Promise<void> {
    const db = tx ?? this.db;
    await db.visibilityPolicy.deleteMany({ where: { ownerType: ownerKind, ownerId } });
    if (ownerKind === 'workspace') await db.workspaceVisibilitySettings.deleteMany({ where: { workspaceId: ownerId } });
    // Этого человека как ИСКЛЮЧЕНИЕ в чужих политиках тоже не остаётся
    if (ownerKind === 'user') await db.visibilityRule.deleteMany({ where: { audienceKind: 'user', audienceId: ownerId } });
    void this.cache.invalidate(ownerKind, ownerId, VISIBILITY_TYPE_KEYS);
  }

  /**
   * Разрыв связи (удаление контакта или блок): исключения «всегда показывать» ДРУГ ДРУГУ
   * снимаются — они выдавались «потому что вы в окружении» (PersonalGraphRegistry).
   * «Никогда» остаётся: запрет не расширяет доступ, а блок — как раз повод его сохранить.
   */
  async onUnlinked(userAId: string, userBId: string): Promise<void> {
    for (const [owner, other] of [
      [userAId, userBId],
      [userBId, userAId],
    ] as const) {
      const res = await this.db.visibilityRule.deleteMany({
        where: { audienceKind: 'user', audienceId: other, effect: 'allow', policy: { ownerType: 'user', ownerId: owner } },
      });
      if (res.count) {
        await this.db.visibilityPolicy.updateMany({ where: { ownerType: 'user', ownerId: owner, recordType: PERSONAL_TYPE, status: 'published' }, data: { version: { increment: 1 } } });
        await this.cache.invalidate('user', owner, [PERSONAL_TYPE]);
      }
    }
  }

  /** Удаление Группы — правила `circle:<id>` владельца снимаются В ТОЙ ЖЕ транзакции. */
  async onCircleDeleted(tx: Tx, ownerId: string, circleId: string): Promise<void> {
    const res = await tx.visibilityRule.deleteMany({ where: { audienceKind: 'circle', audienceId: circleId, policy: { ownerType: 'user', ownerId } } });
    if (res.count) await tx.visibilityPolicy.updateMany({ where: { ownerType: 'user', ownerId, recordType: PERSONAL_TYPE, status: 'published' }, data: { version: { increment: 1 } } });
  }

  /** После коммита удаления Группы: кэш политики владельца. */
  async afterCircleDeleted(ownerId: string): Promise<void> {
    await this.cache.invalidate('user', ownerId, [PERSONAL_TYPE]);
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  private async lock(tx: Tx, ownerId: string, recordType: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`visibility:${ownerId}:${recordType}`}))`;
  }

  private async ensureDraft(tx: Tx, userId: string, workspaceId: string, type: string, preset: VisibilityPresetKey | null) {
    const existing = await tx.visibilityPolicy.findFirst({ where: { ownerType: WS, ownerId: workspaceId, recordType: type, status: 'draft' } });
    if (existing) return existing;
    const last = await tx.visibilityPolicy.aggregate({ where: { ownerType: WS, ownerId: workspaceId, recordType: type }, _max: { version: true } });
    return tx.visibilityPolicy.create({
      data: { ownerType: WS, ownerId: workspaceId, recordType: type, version: (last._max.version ?? 0) + 1, status: 'draft', presetKey: preset, draftToken: randomUUID(), createdById: userId },
    });
  }

  private async ensurePersonal(tx: Tx, userId: string) {
    const existing = await tx.visibilityPolicy.findFirst({ where: { ownerType: 'user', ownerId: userId, recordType: PERSONAL_TYPE, status: 'published' } });
    if (existing) return existing;
    // Версия с 1 (CHECK version >= 1): «ноль» — это «политики нет» в ответе, а не строка в БД
    return tx.visibilityPolicy.create({ data: { ownerType: 'user', ownerId: userId, recordType: PERSONAL_TYPE, version: 1, status: 'published', publishedAt: new Date(), publishedById: userId, createdById: userId } });
  }

  /** Проверка правил организации: цель в реестре, адресат своей организации, маска поля, этап, тариф. */
  private async validateRules(userId: string, workspaceId: string, type: VisibilityRecordType, rules: readonly VisibilityRuleInput[]): Promise<VisibilityRuleInput[]> {
    const def = visibilityTypeDef(type)!;
    const fields = visibilityFieldsOf(type);
    const groups = new Set(visibilityGroupsOf(type));
    const sections = new Set(Object.keys(def.sections));
    const invalid = (fieldKey?: string | null) => badRequest(VISIBILITY_ERROR_CODES.ruleInvalid, undefined, { code: VISIBILITY_ERROR_CODES.ruleInvalid, ...(fieldKey ? { fieldKey } : {}) });
    const orgIds: Record<'department' | 'position' | 'branch', Set<string>> = { department: new Set(), position: new Set(), branch: new Set() };
    const perTarget = new Map<string, number>();
    const dedup = new Map<string, VisibilityRuleInput>();
    for (const r of rules) {
      let targets: VisibilityFieldEntry[];
      if (r.fieldKey) {
        const e = visibilityFieldEntry(type, r.fieldKey);
        if (!e || !isVisibilityFieldConfigurable(type, r.fieldKey)) throw invalid(r.fieldKey);
        if (e.def.class === 'secret' && r.effect === 'allow' && r.level === 'full') throw invalid(r.fieldKey);
        targets = [e];
      } else if (r.groupKey) {
        if (!groups.has(r.groupKey)) throw invalid();
        targets = fields.filter((e) => e.def.group === r.groupKey);
      } else if (r.sectionKey) {
        if (!sections.has(r.sectionKey)) throw invalid();
        targets = fields.filter((e) => e.section === r.sectionKey);
      } else throw invalid();
      if (r.mask && r.mask !== 'hidden' && !targets.some((e) => (e.def.masks ?? []).includes(r.mask!))) throw invalid(r.fieldKey);
      if (r.stage && !(def.stages ?? []).includes(r.stage)) throw invalid(r.fieldKey);
      if (r.audience.kind === 'manager_of' && def.subject !== 'user') throw invalid(r.fieldKey);
      if (r.audience.kind === 'department' || r.audience.kind === 'position' || r.audience.kind === 'branch') orgIds[r.audience.kind].add(r.audience.id);
      const tk = `${r.fieldKey ?? ''}|${r.groupKey ?? ''}|${r.sectionKey ?? ''}`;
      const k = `${tk}|${r.audience.kind}|${r.audience.id ?? ''}|${r.stage ?? ''}`;
      if (!dedup.has(k)) perTarget.set(tk, (perTarget.get(tk) ?? 0) + 1);
      dedup.set(k, r);
    }
    if ([...perTarget.values()].some((n) => n > VISIBILITY_LIMITS.maxAudiencesPerField)) {
      throw badRequest(VISIBILITY_ERROR_CODES.tooManyAudiences, undefined, { code: VISIBILITY_ERROR_CODES.tooManyAudiences });
    }
    if (orgIds.department.size || orgIds.position.size || orgIds.branch.size) {
      await this.entitlements.assertFeature(userId, 'visibility.orgAudiences', { type: 'workspace', id: workspaceId });
      const [d, p, b] = await Promise.all([
        orgIds.department.size ? this.db.staffDepartment.count({ where: { workspaceId, id: { in: [...orgIds.department] } } }) : 0,
        orgIds.position.size ? this.db.staffPosition.count({ where: { workspaceId, id: { in: [...orgIds.position] } } }) : 0,
        orgIds.branch.size ? this.db.staffBranch.count({ where: { workspaceId, id: { in: [...orgIds.branch] } } }) : 0,
      ]);
      if (d !== orgIds.department.size || p !== orgIds.position.size || b !== orgIds.branch.size) throw invalid();
    }
    if ([...dedup.values()].some((r) => r.reveal === 'delegated')) {
      await this.entitlements.assertFeature(userId, 'visibility.revealDelegation', { type: 'workspace', id: workspaceId });
    }
    return [...dedup.values()];
  }

  private ruleData(r: VisibilityRuleInput, i: number): Omit<Prisma.VisibilityRuleCreateManyInput, 'policyId'> {
    return {
      fieldKey: r.fieldKey ?? null,
      groupKey: r.groupKey ?? null,
      sectionKey: r.sectionKey ?? null,
      audienceKind: r.audience.kind,
      audienceId: r.audience.id ?? null,
      effect: r.effect,
      level: r.effect === 'deny' ? 'hidden' : r.level,
      mask: r.mask ?? null,
      reveal: r.reveal ?? 'none',
      stage: r.stage ?? null,
      surfaces: r.surfaces ? (r.surfaces as Prisma.InputJsonValue) : Prisma.JsonNull,
      priority: r.priority ?? i,
    };
  }

  private ruleInputOf(r: RuleRow & { priority?: number }): VisibilityRuleInput {
    return {
      fieldKey: r.fieldKey,
      groupKey: r.groupKey as VisibilityRuleInput['groupKey'],
      sectionKey: r.sectionKey,
      audience: { kind: r.audienceKind, id: r.audienceId } as VisibilityRuleInput['audience'],
      effect: r.effect as 'allow' | 'deny',
      level: r.level as VisibilityLevel,
      mask: (r.mask as VisibilityRuleInput['mask']) ?? null,
      reveal: (r.reveal as VisibilityRuleInput['reveal']) ?? 'none',
      stage: r.stage,
    };
  }

  toDto(row: PolicyWithRules): VisibilityPolicyDto {
    return {
      id: row.id,
      ownerType: row.ownerType as VisibilityPolicyDto['ownerType'],
      ownerId: row.ownerId,
      recordType: row.recordType,
      version: row.version,
      status: row.status as VisibilityPolicyDto['status'],
      presetKey: (row.presetKey as VisibilityPresetKey | null) ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      publishedById: row.publishedById,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      rules: row.rules.map(
        (r): VisibilityRuleDto => ({
          id: r.id,
          fieldKey: r.fieldKey,
          groupKey: r.groupKey as VisibilityRuleDto['groupKey'],
          sectionKey: r.sectionKey,
          audience: { kind: r.audienceKind as VisibilityRuleDto['audience']['kind'], id: r.audienceId },
          effect: r.effect as VisibilityRuleDto['effect'],
          level: r.level as VisibilityLevel,
          mask: (r.mask as VisibilityRuleDto['mask']) ?? null,
          reveal: (r.reveal as VisibilityRuleDto['reveal']) ?? 'none',
          stage: r.stage,
          surfaces: (r.surfaces as VisibilityRuleDto['surfaces']) ?? null,
          priority: r.priority,
        }),
      ),
      // Токен черновика — в диффе; здесь не нужен
    };
  }

  /** После коммита: кэш политики стёрт во всех процессах + сокет «политика сменилась». */
  private async afterChange(ownerKind: 'workspace' | 'user', ownerId: string, recordTypes: VisibilityRecordType[], pv: number): Promise<void> {
    await this.cache.invalidate(ownerKind, ownerId, recordTypes);
    try {
      let userIds: string[] = [ownerId];
      if (ownerKind === 'workspace') {
        userIds = await this.audiences.resolve([{ type: 'workspace', id: ownerId }], { workspaceId: ownerId }, { max: 5000, onOverflow: 'truncate' });
      }
      for (const recordType of recordTypes) {
        const payload: VisibilityChangedBusPayload = { ownerKind, ownerId, recordType, pv, userIds };
        this.events.emit(VISIBILITY_BUS_EVENTS.changed, payload, 'visibility');
      }
    } catch (err) {
      this.logger.warn(`visibility change broadcast failed: ${(err as Error).message}`);
    }
  }
}

/** Поле карточки → код поля учёта действий с ПДн (core/consents); прочее — «публичная карточка». */
function pdFieldOf(fieldKey: string): PdFieldCode {
  switch (fieldKey) {
    case 'phone':
    case 'email':
    case 'avatar':
    case 'bio':
    case 'city':
      return fieldKey;
    case 'lastName':
      return 'last_name';
    case 'birthDayMonth':
    case 'birthYear':
    case 'age':
      return 'date_of_birth';
    default:
      return 'public_card';
  }
}

/** Ключ каталога названия типа: `visibility.types.<t>.title` (точка в ключе типа = вложенность каталога). */
export function typeTitleKey(recordType: string): string {
  return `visibility.types.${recordType}.title`;
}

/**
 * Отпечаток правил черновика для заявки «четырёх глаз»: одобряющий решает про ЭТИ правила —
 * правка черновика после заявки меняет отпечаток (и токен), одобрение к ней не применяется.
 */
export function rulesFingerprint(rules: ReadonlyArray<{ fieldKey: string | null; groupKey: string | null; sectionKey: string | null; audienceKind: string; audienceId: string | null; effect: string; level: string; mask: string | null; reveal: string; stage: string | null }>): string {
  const canon = rules
    .map((r) => [r.fieldKey, r.groupKey, r.sectionKey, r.audienceKind, r.audienceId, r.effect, r.level, r.mask, r.reveal, r.stage].map((x) => x ?? '').join('|'))
    .sort()
    .join('\n');
  return createHash('sha256').update(canon).digest('hex');
}
