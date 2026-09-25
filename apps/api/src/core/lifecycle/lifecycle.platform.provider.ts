import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  LIFECYCLE_FOREVER,
  asWorkspaceId,
  lifecycleErasureRetrySchema,
  lifecycleIndexesReportSchema,
  lifecyclePolicy,
  lifecycleRetentionDryRunSchema,
  lifecycleRetentionOverrideSchema,
  lifecycleRetentionPauseSchema,
  workspacePurgeAt,
  type LifecycleErasureRetryInput,
  type LifecycleErasureStatus,
  type LifecycleRetentionDryRunInput,
  type LifecycleRetentionOverrideInput,
  type LifecycleRetentionPauseInput,
  type PlatformUserLifecyclePanelDto,
  type PlatformWorkspaceLifecyclePanelDto,
  lifecyclePlatformHoldCreateSchema,
  lifecyclePlatformHoldReleaseSchema,
  lifecycleWorkspacePurgeInputSchema,
  type LifecyclePlatformHoldCreateInput,
  type LifecyclePlatformHoldReleaseInput,
  type LifecycleWorkspacePurgeInput,
} from '@superapp/shared';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { DryRun } from '../../shared/context/dry-run.context';
import { DatabaseService } from '../../shared/database/database.service';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleOverrides } from './lifecycle.overrides';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { lifecycleChoiceAt } from './lifecycle.settings';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';

/**
 * Команды Кабинета платформы движка жизненного цикла.
 *
 * `lifecycle.workspace.purge` — окончательное удаление АРХИВНОЙ организации раньше срока
 * архива (запрос поддержки, юридическое требование): риск critical, всегда через второго
 * сотрудника, цель не может быть своей организацией. Живую организацию команда не тронет
 * (сначала архив — обратимо), под заморозкой — отказ. Предпросмотр — план каскада с числом
 * строк по шагам ДО удаления; исполнение ставит каскад джобом В ТРАНЗАКЦИИ команды (журнал
 * команды и джоб коммитятся вместе). Atlassian 2022: удаление скриптом с неверным видом id —
 * здесь вид проверяет БД, объём видит человек, исполнение одобряет второй.
 *
 * `lifecycle.hold.create` / `lifecycle.hold.release` — заморозка платформы (без организации:
 * держит личное человека и данные всех организаций) или от имени организации; снятие любой.
 * Обе — через второго сотрудника (`lifecycle.holds.approve`): постановка останавливает
 * обязательное стирание, снятие возобновляет удаление улик. Заморозку на самого себя
 * сотрудник не ставит (`forbidSelfTarget`).
 *
 * Дашборд «Данные» (Э5): `lifecycle.retention.dryRun` (пробный прогон политики — счёт без
 * удаления), `lifecycle.retention.pause` (пауза раннера политики, step-up),
 * `lifecycle.retention.override` (срок политики не ниже пола закона — «четыре глаза»),
 * `lifecycle.erasure.retry` (повтор застрявшего стирания), `lifecycle.indexes.report` (отчёт
 * неиспользуемых индексов, результат в журнал не пишется). Панели карточки 360:
 * `user.lifecycle` (удаление аккаунта, заявки стирания, заморозки-хранитель) и
 * `workspace.lifecycle` (сроки, отложенные сокращения, заморозки, стирание).
 */
@Injectable()
export class LifecyclePlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly tenant: LifecycleTenantPurgeService,
    private readonly holds: LifecycleHoldsService,
    private readonly db: DatabaseService,
    private readonly panels: PlatformPanelRegistry,
    private readonly purge: LifecyclePurgeRunner,
    private readonly overrides: LifecycleOverrides,
    private readonly erasure: LifecycleErasureService,
    private readonly dashboard: LifecycleDashboardService,
  ) {}

  /** Политика реестра по id команды — либо 404 (опечатка не должна тихо ничего не делать). */
  private policyOf(policyId: string) {
    const p = lifecyclePolicy(policyId);
    if (!p) throw notFound('lifecycle.policyNotFound');
    return p;
  }

  private registerDataCommands(): void {
    this.commands.register<LifecycleRetentionDryRunInput>({
      key: 'lifecycle.retention.dryRun',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleRetentionDryRun.title',
      descriptionKey: 'platform.commands.lifecycleRetentionDryRun.description',
      input: lifecycleRetentionDryRunSchema,
      capability: 'lifecycle.retention.write',
      risk: 'medium',
      target: (i) => ({ type: 'lifecycle_policy', id: i.policyId }),
      execute: async (_ctx, input) => {
        const policy = this.policyOf(input.policyId);
        if (!(await this.purge.modeOf(policy))) throw badRequest('lifecycle.policyNotEnforced');
        // Предпросмотр команды — без постановки: джоб вне транзакции команды не откатить
        if (DryRun.active()) return { result: { queued: false, preview: true } };
        const res = await this.purge.schedule(policy.id, { dryRun: true, anytime: true });
        return { result: { runId: res.runId, queued: res.queued }, afterCommit: async () => this.dashboard.invalidate() };
      },
    });

    this.commands.register<LifecycleRetentionPauseInput>({
      key: 'lifecycle.retention.pause',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleRetentionPause.title',
      descriptionKey: 'platform.commands.lifecycleRetentionPause.description',
      input: lifecycleRetentionPauseSchema,
      capability: 'lifecycle.retention.write',
      risk: 'high',
      stepUp: true,
      reasonRequired: true,
      target: (i) => ({ type: 'lifecycle_policy', id: i.policyId }),
      execute: async (ctx, input, tx) => {
        const policy = this.policyOf(input.policyId);
        const after = await this.overrides.setPaused(tx, policy.id, input.paused, ctx.reason ?? '', ctx.actor.userId);
        return { after, result: { policyId: policy.id, paused: input.paused }, afterCommit: async () => this.dashboard.invalidate() };
      },
    });

    this.commands.register<LifecycleRetentionOverrideInput>({
      key: 'lifecycle.retention.override',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleRetentionOverride.title',
      descriptionKey: 'platform.commands.lifecycleRetentionOverride.description',
      input: lifecycleRetentionOverrideSchema,
      capability: 'lifecycle.retention.write',
      risk: 'critical',
      dualControl: true,
      dryRun: true,
      target: (i) => ({ type: 'lifecycle_policy', id: i.policyId }),
      execute: async (ctx, input, tx) => {
        const policy = this.policyOf(input.policyId);
        // Сброс партиции ведут функции владельца по правилу в БАЗЕ — срок строкой здесь их не сдвинет
        if (policy.enforcement.kind !== 'batched_delete' || policy.enforcement.handler) throw badRequest('lifecycle.overrideNotSupported');
        const floor = policy.retention.floorDays;
        if (input.days !== null && typeof floor === 'number' && input.days < floor) throw badRequest('lifecycle.retentionBelowFloor', { days: floor });
        const after = await this.overrides.setDays(tx, policy.id, input.days, ctx.reason ?? '', ctx.actor.userId);
        return { after, result: { policyId: policy.id, days: input.days }, afterCommit: async () => this.dashboard.invalidate() };
      },
    });

    this.commands.register<LifecycleErasureRetryInput>({
      key: 'lifecycle.erasure.retry',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleErasureRetry.title',
      descriptionKey: 'platform.commands.lifecycleErasureRetry.description',
      input: lifecycleErasureRetrySchema,
      capability: 'lifecycle.erasure.write',
      risk: 'high',
      target: (i) => ({ type: 'lifecycle_erasure', id: i.requestId }),
      execute: async (_ctx, input, tx) => {
        const res = await this.erasure.retry(tx, input.requestId);
        return { result: { requestId: input.requestId, status: res.status }, afterCommit: async () => this.dashboard.invalidate() };
      },
    });

    this.commands.register<Record<string, never>>({
      key: 'lifecycle.indexes.report',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleIndexesReport.title',
      descriptionKey: 'platform.commands.lifecycleIndexesReport.description',
      input: lifecycleIndexesReportSchema,
      capability: 'data.read',
      risk: 'low',
      // Список индексов — справка, не решение: в журнал команд результат не пишется
      persistResult: false,
      target: () => null,
      execute: async () => ({ result: { indexes: await this.dashboard.unusedIndexes() } }),
    });
  }

  private registerPanels(): void {
    this.panels.register({
      key: 'user.lifecycle',
      entity: 'user',
      titleKey: 'platform.panels.userLifecycle',
      capability: 'platform.lookup.read',
      order: 72,
      eager: false,
      load: async (_actor, id): Promise<PlatformUserLifecyclePanelDto> => {
        const [user, requests, custodianHolds] = await Promise.all([
          this.db.user.findUnique({ where: { id }, select: { deletionScheduledAt: true } }),
          this.db.lifecycleErasureRequest.findMany({ where: { subjectType: 'user', subjectId: id }, orderBy: { requestedAt: 'desc' }, take: 10 }),
          this.db.lifecycleHold.count({ where: { custodianUserId: id, releasedAt: null } }),
        ]);
        return {
          deletionScheduledAt: user?.deletionScheduledAt?.toISOString() ?? null,
          erasure: requests.map((r) => ({
            id: r.id,
            status: r.status as LifecycleErasureStatus,
            requestedAt: r.requestedAt.toISOString(),
            effectiveAt: r.effectiveAt.toISOString(),
            completedAt: r.completedAt?.toISOString() ?? null,
          })),
          custodianHolds,
        };
      },
    });
    this.panels.register({
      key: 'workspace.lifecycle',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceLifecycle',
      capability: 'platform.lookup.read',
      order: 67,
      eager: false,
      load: async (_actor, id): Promise<PlatformWorkspaceLifecyclePanelDto> => {
        const now = new Date();
        const [ws, settings, activeHolds, erasure] = await Promise.all([
          this.db.workspace.findUnique({ where: { id }, select: { archivedAt: true, isActive: true } }),
          this.db.lifecycleSetting.findMany({ where: { workspaceId: id }, take: 10 }),
          this.db.lifecycleHold.count({ where: { workspaceId: id, releasedAt: null } }),
          this.db.lifecycleErasureRequest.findFirst({ where: { subjectType: 'workspace', subjectId: id, status: { not: 'cancelled' } }, orderBy: { requestedAt: 'desc' } }),
        ]);
        return {
          archivedAt: ws?.archivedAt?.toISOString() ?? null,
          purgeAt: ws && !ws.isActive && ws.archivedAt ? workspacePurgeAt(ws.archivedAt).toISOString() : null,
          settings: settings.map((row) => ({
            dataClass: row.dataClass,
            days: lifecycleChoiceAt(row, now),
            pending:
              row.pendingSet && row.pendingEffectiveAt && row.pendingEffectiveAt > now
                ? { days: row.pendingDays === null ? LIFECYCLE_FOREVER : row.pendingDays, effectiveAt: row.pendingEffectiveAt.toISOString() }
                : null,
          })),
          activeHolds,
          erasure: erasure ? { id: erasure.id, status: erasure.status as LifecycleErasureStatus, effectiveAt: erasure.effectiveAt.toISOString() } : null,
        };
      },
    });
  }

  onModuleInit(): void {
    this.registerDataCommands();
    this.registerPanels();
    this.commands.register<LifecycleWorkspacePurgeInput>({
      key: 'lifecycle.workspace.purge',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleWorkspacePurge.title',
      descriptionKey: 'platform.commands.lifecycleWorkspacePurge.description',
      input: lifecycleWorkspacePurgeInputSchema,
      capability: 'lifecycle.purge.write',
      risk: 'critical',
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      // Предпросмотр — сколько каскад удалит по шагам плана ДО удаления (Atlassian 2022)
      preview: async (_ctx, input) => {
        const workspaceId = asWorkspaceId(input.workspaceId);
        await this.tenant.assertArchivedWorkspace(workspaceId);
        const { steps, missing } = await this.tenant.preview(workspaceId);
        return { result: { held: await this.tenant.isHeld(workspaceId, { deep: true }), missing, steps: steps.map((st) => ({ key: st.key, rows: st.rows })) } };
      },
      execute: async (_ctx, input, tx) => {
        const workspaceId = asWorkspaceId(input.workspaceId);
        if (await this.tenant.isHeld(workspaceId, { deep: true })) throw conflict('lifecycle.tenantHeld');
        const res = await this.tenant.schedule(workspaceId, tx);
        return { result: { runId: res.runId, queued: res.queued } };
      },
    });

    this.commands.register<LifecyclePlatformHoldCreateInput>({
      key: 'lifecycle.hold.create',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleHoldCreate.title',
      descriptionKey: 'platform.commands.lifecycleHoldCreate.description',
      input: lifecyclePlatformHoldCreateSchema,
      capability: 'lifecycle.holds.write',
      risk: 'high',
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['user', 'workspace'],
      target: (i) =>
        i.scope === 'custodian' && i.custodianUserId
          ? { type: 'user', id: i.custodianUserId, workspaceId: i.workspaceId ?? null }
          : i.workspaceId
            ? { type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }
            : null,
      execute: async (ctx, input, tx) => {
        const hold = await this.holds.create({ ...input, workspaceId: input.workspaceId ?? null }, { id: ctx.actor.userId, kind: 'platform' }, tx);
        return { after: hold, result: { holdId: hold.id } };
      },
    });

    this.commands.register<LifecyclePlatformHoldReleaseInput>({
      key: 'lifecycle.hold.release',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleHoldRelease.title',
      descriptionKey: 'platform.commands.lifecycleHoldRelease.description',
      input: lifecyclePlatformHoldReleaseSchema,
      capability: 'lifecycle.holds.write',
      risk: 'high',
      dualControl: true,
      target: (i) => ({ type: 'lifecycle_hold', id: i.holdId }),
      execute: async (ctx, input, tx) => {
        const hold = await this.holds.release(input.holdId, input.note, { id: ctx.actor.userId, kind: 'platform' }, {}, tx);
        return { after: hold, result: { holdId: hold.id, releasedAt: hold.releasedAt } };
      },
    });
  }
}
