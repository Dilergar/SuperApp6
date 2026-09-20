import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Injectable, OnModuleInit, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PLATFORM_ERROR_CODES,
  analyticsDashboardCreateSchema,
  analyticsDashboardUpdateSchema,
  analyticsEventSetStatusInputSchema,
  analyticsQuerySchema,
  analyticsReportCreateSchema,
  analyticsReportUpdateSchema,
  analyticsRollupRebuildInputSchema,
  analyticsUserForgetInputSchema,
  type AnalyticsEventSetStatusInput,
  type AnalyticsRollupRebuildInput,
  type AnalyticsUserForgetInput,
} from '@superapp/shared';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { CurrentPlatformActor, PlatformCapability, PlatformRoute, type PlatformActor } from '../../shared/decorators/platform.decorator';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { RedisService } from '../../shared/redis/redis.service';
import { tooMany } from '../../shared/errors/api-error';
import { JobsService } from '../jobs/jobs.service';
import { AnalyticsActivityService } from './analytics.activity.service';
import { AnalyticsCatalogService } from './analytics.catalog.service';
import { ANALYTICS_JOBS } from './analytics.constants';
import { AnalyticsIngestService } from './analytics.ingest.service';
import { addDaysIso, daysBetween } from './analytics.metrics';
import { AnalyticsQueryService } from './analytics.query.service';
import { AnalyticsReportsService } from './analytics.reports.service';
import { AnalyticsService } from './analytics.service';

/** Потолок запросов отчётов на сотрудника в минуту (дорогие чтения — свой бюджет). */
const QUERIES_PER_MINUTE = 240;

/**
 * Регистрации движка в кабинете: команды реестра событий, забвения и пересчёта роллапов +
 * панели «Активность» карточки 360. Права проверяет исполнитель по capability команды.
 */
@Injectable()
export class AnalyticsPlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly analytics: AnalyticsService,
    private readonly activity: AnalyticsActivityService,
    private readonly jobs: JobsService,
    private readonly ingest: AnalyticsIngestService,
  ) {}

  onModuleInit(): void {
    this.commands.register<AnalyticsEventSetStatusInput>({
      key: 'analytics.event.setStatus',
      version: 1,
      group: 'analytics',
      titleKey: 'platform.commands.analyticsEventSetStatus.title',
      descriptionKey: 'platform.commands.analyticsEventSetStatus.description',
      input: analyticsEventSetStatusInputSchema,
      capability: 'analytics.manage',
      risk: 'medium',
      // Выключение события — решение о данных всех клиентов: причину объясняют всегда
      reasonRequired: true,
      target: (i) => ({ type: 'analytics_event', id: i.eventKey }),
      execute: async (ctx, input, tx) => {
        const before = await tx.analyticsEventOverride.findUnique({ where: { eventKey: input.eventKey } });
        const after = await tx.analyticsEventOverride.upsert({
          where: { eventKey: input.eventKey },
          create: { eventKey: input.eventKey, status: input.status, reason: ctx.reason, setBy: ctx.actor.userId },
          update: { status: input.status, reason: ctx.reason, setBy: ctx.actor.userId, setAt: new Date() },
        });
        // Кэш рубильника этого инстанса — сбросить сразу (соседние дочитают за ≤ 30 с)
        this.ingest.invalidateOverrides();
        return { before, after };
      },
    });
    this.commands.register<AnalyticsUserForgetInput>({
      key: 'analytics.user.forget',
      version: 1,
      group: 'analytics',
      titleKey: 'platform.commands.analyticsUserForget.title',
      descriptionKey: 'platform.commands.analyticsUserForget.description',
      input: analyticsUserForgetInputSchema,
      capability: 'analytics.manage',
      risk: 'high',
      forbidSelfTarget: true,
      entities: ['user'],
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (_ctx, input, tx) => {
        await this.analytics.forgetUser(tx, input.userId);
        return { result: { queued: true } };
      },
    });
    this.commands.register<AnalyticsRollupRebuildInput>({
      key: 'analytics.rollup.rebuild',
      version: 1,
      group: 'analytics',
      titleKey: 'platform.commands.analyticsRollupRebuild.title',
      descriptionKey: 'platform.commands.analyticsRollupRebuild.description',
      input: analyticsRollupRebuildInputSchema,
      capability: 'analytics.manage',
      risk: 'medium',
      dryRun: true,
      target: (i) => ({ type: 'analytics_rollup', id: `${i.from}..${i.to}` }),
      execute: async (_ctx, input, tx) => {
        const n = daysBetween(input.from, input.to) + 1;
        for (let i = 0; i < n; i++) {
          const day = addDaysIso(input.from, i);
          await this.jobs.enqueue(tx, { type: ANALYTICS_JOBS.rollupDay, payload: { day }, uniqueKey: `rollup:${day}` });
        }
        return { result: { days: n } };
      },
    });

    this.panels.register({
      key: 'user.analytics',
      entity: 'user',
      titleKey: 'platform.panels.userAnalytics',
      capability: 'analytics.person.read',
      order: 40,
      load: async (_actor, id) => this.activity.userPanel(id),
    });
    this.panels.register({
      key: 'workspace.analytics',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceAnalytics',
      capability: 'analytics.person.read',
      order: 40,
      load: async (_actor, id) => this.activity.workspacePanel(id),
    });
  }
}

/**
 * Чтения и рабочие материалы раздела «Аналитика» Кабинета. Статические пути — ДО `:id`.
 * Любой запрос — через `AnalyticsQueryService` (скоуп, k-анонимность, таймаут внутри).
 */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/analytics')
export class AnalyticsPlatformController {
  constructor(
    private readonly query: AnalyticsQueryService,
    private readonly catalog: AnalyticsCatalogService,
    private readonly reports: AnalyticsReportsService,
    private readonly redis: RedisService,
  ) {}

  private async budget(actor: PlatformActor): Promise<void> {
    const key = `analytics:rate:${actor.userId}:${Math.floor(Date.now() / 60_000)}`;
    try {
      const client = this.redis.getClient();
      const n = await client.incr(key);
      if (n === 1) await client.expire(key, 120);
      if (n > QUERIES_PER_MINUTE) throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 60 });
    } catch (err) {
      if ((err as { status?: number }).status === 429) throw err;
    }
  }

  @PlatformCapability('analytics.read')
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run an analytics query (trend, funnel, retention, breakdown, lifecycle, adoption, journeys)' })
  async run(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown) {
    await this.budget(actor);
    const q = analyticsQuerySchema.parse(body ?? {});
    return { success: true, data: await this.query.run(q) };
  }

  @PlatformCapability('analytics.read')
  @Get('events')
  @ApiOperation({ summary: 'Event registry with 14-day volumes, last seen day and kill-switch overrides' })
  async events() {
    return { success: true, data: await this.catalog.events() };
  }

  @PlatformCapability('analytics.read')
  @Get('quality')
  @ApiOperation({ summary: 'Data quality: quarantine, stream lag, outbox backlog, ingest counters' })
  async quality() {
    return { success: true, data: await this.catalog.quality() };
  }

  // ---- Отчёты ----

  @PlatformCapability('analytics.read')
  @Get('reports')
  @ApiOperation({ summary: 'Saved reports visible to the staff member (shared + own private)' })
  async listReports(@CurrentPlatformActor() actor: PlatformActor) {
    return { success: true, data: await this.reports.listReports(actor) };
  }

  @PlatformCapability('analytics.read')
  @Post('reports')
  @ApiOperation({ summary: 'Save a report' })
  async createReport(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown) {
    return { success: true, data: await this.reports.createReport(actor, analyticsReportCreateSchema.parse(body ?? {})) };
  }

  @PlatformCapability('analytics.read')
  @Get('reports/:id')
  @ApiOperation({ summary: 'One saved report' })
  async getReport(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    return { success: true, data: await this.reports.getReport(actor, id) };
  }

  @PlatformCapability('analytics.read')
  @Patch('reports/:id')
  @ApiOperation({ summary: 'Change a report (author or analytics.manage; system reports are read-only)' })
  async updateReport(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.reports.updateReport(actor, id, analyticsReportUpdateSchema.parse(body ?? {})) };
  }

  @PlatformCapability('analytics.read')
  @Delete('reports/:id')
  @ApiOperation({ summary: 'Delete a report (its tiles leave every dashboard)' })
  async deleteReport(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    await this.reports.deleteReport(actor, id);
    return { success: true, data: null };
  }

  // ---- Дашборды ----

  @PlatformCapability('analytics.read')
  @Get('dashboards')
  @ApiOperation({ summary: 'Dashboards: system ones first, then shared and own private' })
  async listDashboards(@CurrentPlatformActor() actor: PlatformActor) {
    return { success: true, data: await this.reports.listDashboards(actor) };
  }

  @PlatformCapability('analytics.read')
  @Post('dashboards')
  @ApiOperation({ summary: 'Create a dashboard' })
  async createDashboard(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown) {
    return { success: true, data: await this.reports.createDashboard(actor, analyticsDashboardCreateSchema.parse(body ?? {})) };
  }

  @PlatformCapability('analytics.read')
  @Get('dashboards/:id')
  @ApiOperation({ summary: 'Dashboard with its tile reports (id or system key)' })
  async getDashboard(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    return { success: true, data: await this.reports.getDashboard(actor, id) };
  }

  @PlatformCapability('analytics.read')
  @Patch('dashboards/:id')
  @ApiOperation({ summary: 'Change a dashboard: title, ordered tiles, visibility' })
  async updateDashboard(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.reports.updateDashboard(actor, id, analyticsDashboardUpdateSchema.parse(body ?? {})) };
  }

  @PlatformCapability('analytics.read')
  @Delete('dashboards/:id')
  @ApiOperation({ summary: 'Delete a dashboard' })
  async deleteDashboard(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    await this.reports.deleteDashboard(actor, id);
    return { success: true, data: null };
  }
}
