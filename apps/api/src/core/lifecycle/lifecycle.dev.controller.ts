import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { asWorkspaceId, isUuid, lifecycleTenantPurgePlan } from '@superapp/shared';
import { z } from 'zod';
import { isDevEnv } from '../../shared/config/env.validation';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { LifecycleHealth } from './lifecycle.health';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecyclePartitions } from './lifecycle.partitions';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { LifecycleRuns } from './lifecycle.runs';
import { LifecycleTenantPurgeService } from './lifecycle.tenant-purge';

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
 * Дев-полигон движка жизненного цикла (verify-partitions.cjs, verify-purge.cjs): партиции,
 * прогоны сроков, подмена сигналов здоровья, loose FK, предпросмотр каскада организации.
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
  plan() {
    this.assertDev();
    return {
      success: true,
      data: {
        enforced: this.purge.enforceablePolicies().map((p) => ({ id: p.id, mode: this.purge.mode(p)?.kind ?? null })),
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
