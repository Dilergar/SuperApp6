import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  LIFECYCLE_FOREVER,
  asWorkspaceId,
  lifecycleErasureReplaySchema,
  lifecycleErasureRetrySchema,
  lifecycleIndexesReportSchema,
  lifecyclePolicy,
  lifecycleRetentionDryRunSchema,
  lifecycleRetentionOverrideSchema,
  lifecycleRetentionPauseSchema,
  workspacePurgeAt,
  type LifecycleErasureReplayInput,
  type LifecycleErasureRetryInput,
  type LifecycleErasureStatus,
  type LifecycleRetentionDryRunInput,
  type LifecycleRetentionOverrideInput,
  type LifecycleRetentionPauseInput,
  type PlatformLifecycleExportLineDto,
  type PlatformUserLifecyclePanelDto,
  type PlatformWorkspaceLifecyclePanelDto,
  lifecyclePlatformHoldCreateSchema,
  lifecyclePlatformHoldReleaseSchema,
  lifecycleWorkspacePurgeInputSchema,
  type LifecyclePlatformHoldCreateInput,
  type LifecyclePlatformHoldReleaseInput,
  type LifecycleWorkspacePurgeInput,
  lifecycleRestoreExtractSchema,
  lifecycleRestoreImportSchema,
  type LifecycleRestoreExtractInput,
  type LifecycleRestoreImportInput,
} from '@superapp/shared';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { DryRun } from '../../shared/context/dry-run.context';
import { DatabaseService } from '../../shared/database/database.service';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleExportService } from './lifecycle.export.service';
import { LifecycleRestoreService } from './lifecycle.restore.service';
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
    private readonly exports: LifecycleExportService,
    private readonly restore: LifecycleRestoreService,
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

    // Реплей журнала стираний после восстановления базы (рунбук PITR, до открытия трафика):
    // псевдонимы из NDJSON журнала объектного хранилища — скрипт lifecycle-replay-erasures.cjs.
    // Стирает людей и организации массово — критично, всегда через второго сотрудника
    this.commands.register<LifecycleErasureReplayInput>({
      key: 'lifecycle.erasure.replay',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleErasureReplay.title',
      descriptionKey: 'platform.commands.lifecycleErasureReplay.description',
      input: lifecycleErasureReplaySchema,
      capability: 'lifecycle.erasure.write',
      risk: 'critical',
      dualControl: true,
      reasonRequired: true,
      target: () => null,
      preview: async (_ctx, input) => ({ result: { pseudonyms: new Set(input.pseudonyms).size } }),
      execute: async (_ctx, input, tx) => {
        // Предпросмотр команды — без постановки: прогон и джоб вне транзакции команды не откатить
        if (DryRun.active()) return { result: { preview: true, pseudonyms: new Set(input.pseudonyms).size } };
        const res = await this.erasure.startJournalReplay(tx, input.pseudonyms);
        return { result: res, afterCommit: async () => this.dashboard.invalidate() };
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

  /**
   * Восстановление арендатора (Atlassian 2022): извлечь строки организации из кластера на точку
   * времени в подписанный архив и вернуть их в живую базу — обе команды critical, через
   * второго сотрудника; предпросмотр показывает объём ДО действия. Стёртую организацию не
   * восстанавливает ни одна из них (стирание побеждает).
   */
  private registerRestoreCommands(): void {
    this.commands.register<LifecycleRestoreExtractInput>({
      key: 'lifecycle.restore.extract',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleRestoreExtract.title',
      descriptionKey: 'platform.commands.lifecycleRestoreExtract.description',
      input: lifecycleRestoreExtractSchema,
      capability: 'lifecycle.restore.write',
      risk: 'critical',
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      preview: async (_ctx, input) => {
        await this.restore.assertNotErased(input.workspaceId);
        return { result: { tables: await this.restore.previewExtract(input.workspaceId) } };
      },
      execute: async (ctx, input, tx) => {
        this.restore.assertSource();
        await this.restore.assertNotErased(input.workspaceId);
        // Восстановленный кластер своего «когда» не знает: точку PITR называет сотрудник
        if (process.env.LIFECYCLE_RESTORE_SOURCE_URL && !input.snapshotAt) throw badRequest('lifecycle.restoreSnapshotRequired');
        if (DryRun.active()) return { result: { preview: true } };
        const exportId = await this.exports.requestRestoreArchive(tx, ctx.actor.userId, input.workspaceId, input.snapshotAt ? new Date(input.snapshotAt) : new Date());
        return { result: { exportId }, afterCommit: async () => this.dashboard.invalidate() };
      },
    });

    this.commands.register<LifecycleRestoreImportInput>({
      key: 'lifecycle.restore.import',
      version: 1,
      group: 'lifecycle',
      titleKey: 'platform.commands.lifecycleRestoreImport.title',
      descriptionKey: 'platform.commands.lifecycleRestoreImport.description',
      input: lifecycleRestoreImportSchema,
      capability: 'lifecycle.restore.write',
      risk: 'critical',
      dualControl: true,
      target: (i) => ({ type: 'lifecycle_export', id: i.exportId }),
      // Предпросмотр: подпись и хэши сверены, строк в архиве и сколько из них уже есть (пропуск)
      preview: async (_ctx, input) => ({ result: await this.restore.previewImport(input.exportId) }),
      execute: async (_ctx, input, tx) => {
        if (DryRun.active()) return { result: { preview: true } };
        const res = await this.restore.startImport(tx, input.exportId);
        return { result: res, afterCommit: async () => this.dashboard.invalidate() };
      },
    });
  }

  /** Последние выгрузки субъекта для карточки 360: статус и объём — без ссылок и содержимого. */
  private async exportLines(subjectType: 'user' | 'workspace', subjectId: string): Promise<PlatformLifecycleExportLineDto[]> {
    const rows = await this.db.lifecycleExport.findMany({
      where: { subjectType, subjectId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, mode: true, status: true, createdAt: true, bytes: true, downloads: true },
    });
    return rows.map((r) => ({
      id: r.id,
      mode: r.mode as PlatformLifecycleExportLineDto['mode'],
      status: r.status as PlatformLifecycleExportLineDto['status'],
      createdAt: r.createdAt.toISOString(),
      bytes: Number(r.bytes),
      downloads: r.downloads,
    }));
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
        const [user, requests, custodianHolds, exports] = await Promise.all([
          this.db.user.findUnique({ where: { id }, select: { deletionScheduledAt: true } }),
          this.db.lifecycleErasureRequest.findMany({ where: { subjectType: 'user', subjectId: id }, orderBy: { requestedAt: 'desc' }, take: 10 }),
          this.db.lifecycleHold.count({ where: { custodianUserId: id, releasedAt: null } }),
          this.exportLines('user', id),
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
          exports,
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
        const [ws, settings, activeHolds, erasure, exports] = await Promise.all([
          this.db.workspace.findUnique({ where: { id }, select: { archivedAt: true, isActive: true } }),
          this.db.lifecycleSetting.findMany({ where: { workspaceId: id }, take: 10 }),
          this.db.lifecycleHold.count({ where: { workspaceId: id, releasedAt: null } }),
          this.db.lifecycleErasureRequest.findFirst({ where: { subjectType: 'workspace', subjectId: id, status: { not: 'cancelled' } }, orderBy: { requestedAt: 'desc' } }),
          this.exportLines('workspace', id),
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
          exports,
        };
      },
    });
  }

  onModuleInit(): void {
    this.registerDataCommands();
    this.registerRestoreCommands();
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
