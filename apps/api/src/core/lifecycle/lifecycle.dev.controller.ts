import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { asWorkspaceId, isUuid, lifecycleCanaryRunSchema, lifecyclePlatformHoldCreateSchema, lifecyclePlatformHoldReleaseSchema, lifecycleTenantPurgePlan } from '@superapp/shared';
import { z } from 'zod';
import { isDevEnv } from '../../shared/config/env.validation';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { DatabaseService } from '../../shared/database/database.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { KeysStoreService } from '../keys/keys.store.service';
import { userScope, workspaceScope } from '../keys/keys.constants';
import { LifecycleCanaryBusyError, LifecycleCanaryService } from './lifecycle.canary';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleHealth } from './lifecycle.health';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecyclePartitions } from './lifecycle.partitions';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { LifecycleRuns } from './lifecycle.runs';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';

const erasureRunSchema = z.object({ requestId: z.string().uuid(), now: z.boolean().optional() }).strict();
const purgeRunSchema = z.object({ policyId: z.string().min(1).max(96), dryRun: z.boolean().optional(), force: z.boolean().optional() }).strict();
const purgeScheduleSchema = purgeRunSchema.extend({ anytime: z.boolean().optional() }).strict();
const healthOverrideSchema = z
  .object({
    replicationLagSec: z.number().min(0).optional(),
    archiverFailing: z.boolean().optional(),
    vacuumRunning: z.boolean().optional(),
    walBytesPerSec: z.number().min(0).optional(),
    lockWaiters: z.number().int().min(0).optional(),
    eventLoopP99Ms: z.number().min(0).optional(),
  })
  .strict();

/**
 * Дев-полигон движка жизненного цикла (verify-partitions.cjs, verify-purge.cjs,
 * verify-lifecycle.cjs): партиции, прогоны сроков, подмена сигналов здоровья, loose FK,
 * предпросмотр каскада организации, стирание субъекта, заморозки, канарейка.
 * Вне NODE_ENV=development — 404, как будто ручек нет; в проде то же видит дашборд «Данные»
 * Кабинета платформы (core/platform, Э5).
 */
@ApiTags('Lifecycle')
@ApiBearerAuth()
@Controller('lifecycle/dev')
export class LifecycleDevController {
  constructor(
    private readonly partitions: LifecyclePartitions,
    private readonly purge: LifecyclePurgeRunner,
    private readonly runs: LifecycleRuns,
    private readonly health: LifecycleHealth,
    private readonly looseFk: LifecycleLooseFk,
    private readonly tenant: LifecycleTenantPurgeService,
    private readonly erasure: LifecycleErasureService,
    private readonly holds: LifecycleHoldsService,
    private readonly keysStore: KeysStoreService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw notFound('dev.developmentOnly');
  }

  @Get('partitions')
  @ApiOperation({ summary: '[dev] Health of every partitioned log: partitions ahead, detach pending, DEFAULT partition' })
  async partitionsHealth() {
    this.assertDev();
    const health = await this.partitions.health();
    return { success: true, data: health.map((h) => ({ ...h, oldestFrom: h.oldestFrom?.toISOString() ?? null })) };
  }

  @Post('partitions/maintain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the nightly partition maintenance now (ahead, retention drops, ANALYZE)' })
  async maintain() {
    this.assertDev();
    const { dropped, health } = await this.partitions.maintain();
    return { success: true, data: { dropped, health: health.map((h) => ({ ...h, oldestFrom: h.oldestFrom?.toISOString() ?? null })) } };
  }

  @Get('plan')
  @ApiOperation({ summary: '[dev] Retention plan: policies the runner enforces, the organisation purge plan, loose-FK tracked tables' })
  async plan() {
    this.assertDev();
    return {
      success: true,
      data: {
        enforced: await Promise.all((await this.purge.enforceablePolicies()).map(async (p) => ({ id: p.id, mode: (await this.purge.modeOf(p))?.kind ?? null }))),
        tenantPlan: lifecycleTenantPurgePlan().map((s) => ({ key: s.key, kind: s.kind })),
        looseFkTables: this.looseFk.trackedTables(),
      },
    };
  }

  @Post('purge/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run one retention policy now in-process (no window, no queue); dryRun only counts' })
  async purgeRun(@Body() body: unknown) {
    this.assertDev();
    const input = purgeRunSchema.parse(body ?? {});
    try {
      const res = await this.purge.runInline(input.policyId, input);
      return { success: true, data: { ...serializeRun(res.run), outcome: res.outcome, healthReason: res.healthReason } };
    } catch (err) {
      if (err instanceof Error && /not enforceable/.test(err.message)) throw badRequest('dev.lifecyclePolicyNotEnforceable');
      throw err;
    }
  }

  @Post('purge/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Queue a retention run as the nightly plan would (job + run row in one transaction)' })
  async purgeSchedule(@Body() body: unknown) {
    this.assertDev();
    const input = purgeScheduleSchema.parse(body ?? {});
    try {
      return { success: true, data: await this.purge.schedule(input.policyId, input) };
    } catch (err) {
      if (err instanceof Error && /not enforceable/.test(err.message)) throw badRequest('dev.lifecyclePolicyNotEnforceable');
      throw err;
    }
  }

  @Get('runs/:id')
  @ApiOperation({ summary: '[dev] One lifecycle run (progress, expectation, stop reason, report)' })
  async run(@Param('id') id: string) {
    this.assertDev();
    const run = isUuid(id) ? await this.runs.get(id) : null;
    if (!run) throw notFound('db.notFound');
    return { success: true, data: serializeRun(run) };
  }

  @Get('health')
  @ApiOperation({ summary: '[dev] Database health verdict of the purge runner (with overrides applied)' })
  async healthCheck() {
    this.assertDev();
    return { success: true, data: await this.health.check(null) };
  }

  @Post('health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Override health signals of the purge runner ({} clears the override)' })
  healthOverride(@Body() body: unknown) {
    this.assertDev();
    this.health.override(healthOverrideSchema.parse(body ?? {}));
    return { success: true };
  }

  @Post('loose-fk/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Process the loose-FK backlog now (one pass within the budget)' })
  async looseFkRun() {
    this.assertDev();
    const res = await this.looseFk.process(30_000);
    return { success: true, data: { ...res, backlog: await this.looseFk.backlog() } };
  }

  // ---- стирание субъекта ----

  /** Исполнить заявку сейчас без бюджета (`now` — срок переносится на сейчас: грейс не ждём). */
  @Post('erasure/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Execute an erasure request now (optionally moving its effective time to now)' })
  async erasureRun(@Body() body: unknown) {
    this.assertDev();
    const { requestId, now } = erasureRunSchema.parse(body ?? {});
    if (now) await this.db.lifecycleErasureRequest.updateMany({ where: { id: requestId, status: { in: ['scheduled', 'held'] } }, data: { effectiveAt: new Date() } });
    const out = await this.erasure.execute(requestId, null);
    const row = await this.db.lifecycleErasureRequest.findUnique({ where: { id: requestId } });
    return { success: true, data: { outcome: out, status: row?.status ?? null } };
  }

  /**
   * «Перемотать время» одной заявки: версии ключей её скоупа созревают к уничтожению сейчас
   * (движок ключей уничтожает их своим путём), окно бэкапов — в прошлом; затем тик доводит
   * этапы до сертификата. Только дев: в проде время не перематывается.
   */
  @Post('erasure/advance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Fast-forward an erasure request: keys destroyed and the backup window passed, then tick' })
  async erasureAdvance(@Body() body: unknown) {
    this.assertDev();
    const { requestId } = erasureRunSchema.parse(body ?? {});
    const r = await this.db.lifecycleErasureRequest.findUnique({ where: { id: requestId } });
    if (!r) throw notFound('lifecycle.receiptNotFound');
    const scope = r.subjectType === 'user' ? userScope(r.subjectId) : workspaceScope(r.subjectId);
    const past = new Date(Date.now() - 1000);
    await this.db.cryptoKeyVersion.updateMany({ where: { key: { scope }, state: 'destroy_scheduled' }, data: { destroyScheduledAt: past } });
    await this.keysStore.destroyDue();
    await this.db.lifecycleErasureRequest.updateMany({ where: { id: requestId, backupsClearAt: { not: null } }, data: { backupsClearAt: past } });
    const tick = await this.erasure.tick();
    const row = await this.db.lifecycleErasureRequest.findUnique({ where: { id: requestId } });
    return { success: true, data: { tick, status: row?.status ?? null } };
  }

  @Post('erasure/tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the erasure orchestrator tick now' })
  async erasureTick() {
    this.assertDev();
    return { success: true, data: await this.erasure.tick() };
  }

  @Post('erasure/journal/export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Export pending erasure journal rows to object storage now' })
  async erasureJournalExport() {
    this.assertDev();
    return { success: true, data: { rows: await this.erasure.exportJournal() } };
  }

  // ---- заморозки (сьюту не нужен вход в Кабинет с «четырьмя глазами») ----

  @Post('holds')
  @ApiOperation({ summary: '[dev] Place a legal hold directly (platform when workspaceId is empty)' })
  async holdCreate(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const input = lifecyclePlatformHoldCreateSchema.parse(body ?? {});
    return { success: true, data: await this.holds.create({ ...input, workspaceId: input.workspaceId ?? null }, { id: user.sub, kind: 'user' }) };
  }

  @Post('holds/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Release any legal hold directly' })
  async holdRelease(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { holdId, note } = lifecyclePlatformHoldReleaseSchema.parse(body ?? {});
    return { success: true, data: await this.holds.release(holdId, note, { id: user.sub, kind: 'user' }) };
  }

  // ---- канарейка стирания ----

  /** Прогон канарейки сейчас (синхронно); `leak` — подсадить утечку после стирания (проверка самой канарейки). */
  @Post('canary/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the erasure canary now; optionally plant a leak after the erasure' })
  async canaryRun(@Body() body: unknown) {
    this.assertDev();
    const { leak } = lifecycleCanaryRunSchema.parse(body ?? {});
    try {
      return { success: true, data: await this.canary.run({ leak }) };
    } catch (err) {
      if (err instanceof LifecycleCanaryBusyError) throw conflict('lifecycle.canaryRunning');
      throw err;
    }
  }

  @Get('canary/coverage')
  @ApiOperation({ summary: '[dev] Stores of the erasure plan the canary must seed' })
  canaryCoverage() {
    this.assertDev();
    return { success: true, data: { policies: this.canary.coverage() } };
  }

  @Get('tenant/:workspaceId/preview')
  @ApiOperation({ summary: '[dev] Organisation purge preview: plan steps with expected rows and unregistered hooks' })
  async tenantPreview(@Param('workspaceId') workspaceId: string) {
    this.assertDev();
    if (!isUuid(workspaceId)) throw notFound('db.notFound');
    return { success: true, data: await this.tenant.preview(asWorkspaceId(workspaceId)) };
  }
}

function serializeRun(r: Awaited<ReturnType<LifecycleRuns['get']>> & object) {
  return { ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null };
}
