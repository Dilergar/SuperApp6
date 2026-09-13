import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, type AnalyticsDashboard, type AnalyticsReport } from '@prisma/client';
import {
  ANALYTICS_ERROR_CODES,
  analyticsQuerySchema,
  analyticsTileSchema,
  type AnalyticsDashboardCreateInput,
  type AnalyticsDashboardDetailDto,
  type AnalyticsDashboardDto,
  type AnalyticsDashboardUpdateInput,
  type AnalyticsQueryInput,
  type AnalyticsReportCreateInput,
  type AnalyticsReportDto,
  type AnalyticsReportUpdateInput,
  type AnalyticsTile,
  type AnalyticsViz,
  type AnalyticsVisibility,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { badRequest, forbidden, notFound } from '../../shared/errors/api-error';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';
import { SYSTEM_DASHBOARDS, SYSTEM_DASHBOARD_ORDER, SYSTEM_REPORTS } from './analytics.system-dashboards';

const canManage = (actor: PlatformActor) => actor.capabilities.includes('analytics.manage');

/**
 * Сохранённые отчёты и дашборды Кабинета. Общие по умолчанию (видят все с
 * `analytics.read`), `private` — черновик автора. Правит автор или `analytics.manage`;
 * системные (`systemKey`, засев из кода) не правит никто — «изменить» = сделать копию.
 * Это рабочие материалы кабинета, а не данные продукта: мутации идут маршрутами с
 * capability, без журнала команд (журнал — у команд, меняющих продукт и людей).
 */
@Injectable()
export class AnalyticsReportsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsReportsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    void this.redis
      .withLock('analytics:seed-system-dashboards', 60_000, () => this.seedSystem())
      .catch((err: unknown) => this.logger.error(`analytics system dashboards seed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Засев системных отчётов и дашбордов (идемпотентно: запросы и плитки обновляются из кода). */
  async seedSystem(): Promise<void> {
    const ids = new Map<string, string>();
    for (const def of SYSTEM_REPORTS) {
      const query = analyticsQuerySchema.parse(def.query) as unknown as Prisma.InputJsonValue;
      const row = await this.db.analyticsReport.upsert({
        where: { systemKey: def.systemKey },
        create: { systemKey: def.systemKey, query, viz: def.viz, visibility: 'shared' },
        update: { query, viz: def.viz, visibility: 'shared' },
      });
      ids.set(def.systemKey, row.id);
    }
    for (const def of SYSTEM_DASHBOARDS) {
      const tiles = def.tiles.map((t) => ({ reportId: ids.get(t.report)!, span: t.span })).filter((t) => !!t.reportId);
      await this.db.analyticsDashboard.upsert({
        where: { systemKey: def.systemKey },
        create: { systemKey: def.systemKey, tiles, visibility: 'shared' },
        update: { tiles, visibility: 'shared' },
      });
    }
    // Системное, убранное из кода, уходит и из базы (отчёт — с плиток всех дашбордов):
    // иначе библиотека копила бы «системные» отчёты, которые больше никто не засевает
    const staleReports = await this.db.analyticsReport.findMany({
      where: { systemKey: { not: null, notIn: SYSTEM_REPORTS.map((d) => d.systemKey) } },
      select: { id: true },
    });
    for (const r of staleReports) {
      await this.db.$transaction(async (tx) => {
        await this.detachFromDashboards(tx, r.id, null);
        await tx.analyticsReport.delete({ where: { id: r.id } });
      });
    }
    await this.db.analyticsDashboard.deleteMany({ where: { systemKey: { not: null, notIn: SYSTEM_DASHBOARDS.map((d) => d.systemKey) } } });
  }

  // ---- Отчёты ----

  private visibleWhere(actor: PlatformActor) {
    return { OR: [{ visibility: 'shared' }, { createdBy: actor.userId }] };
  }

  private reportDto(r: AnalyticsReport, actor: PlatformActor): AnalyticsReportDto {
    return {
      id: r.id,
      title: r.title,
      systemKey: r.systemKey,
      query: r.query as unknown as AnalyticsQueryInput,
      viz: (r.viz as AnalyticsViz | null) ?? null,
      visibility: r.visibility as AnalyticsVisibility,
      createdBy: r.createdBy,
      canEdit: !r.systemKey && (r.createdBy === actor.userId || canManage(actor)),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private assertCanEdit(row: { systemKey: string | null; createdBy: string | null }, actor: PlatformActor): void {
    if (row.systemKey) throw forbidden('analytics.system_read_only', undefined, { code: ANALYTICS_ERROR_CODES.systemReadOnly });
    if (row.createdBy !== actor.userId && !canManage(actor)) {
      throw forbidden('analytics.not_author', undefined, { code: ANALYTICS_ERROR_CODES.notAuthor });
    }
  }

  async listReports(actor: PlatformActor): Promise<AnalyticsReportDto[]> {
    const rows = await this.db.analyticsReport.findMany({
      where: this.visibleWhere(actor),
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => this.reportDto(r, actor));
  }

  async getReport(actor: PlatformActor, id: string): Promise<AnalyticsReportDto> {
    const row = await this.db.analyticsReport.findFirst({ where: { id, ...this.visibleWhere(actor) } });
    if (!row) throw notFound('analytics.report_not_found', undefined, { code: ANALYTICS_ERROR_CODES.reportNotFound });
    return this.reportDto(row, actor);
  }

  async createReport(actor: PlatformActor, input: AnalyticsReportCreateInput): Promise<AnalyticsReportDto> {
    const row = await this.db.analyticsReport.create({
      data: {
        title: input.title,
        query: input.query as unknown as Prisma.InputJsonValue,
        viz: input.viz ?? null,
        visibility: input.visibility,
        createdBy: actor.userId,
      },
    });
    return this.reportDto(row, actor);
  }

  async updateReport(actor: PlatformActor, id: string, input: AnalyticsReportUpdateInput): Promise<AnalyticsReportDto> {
    const row = await this.db.analyticsReport.findFirst({ where: { id, ...this.visibleWhere(actor) } });
    if (!row) throw notFound('analytics.report_not_found', undefined, { code: ANALYTICS_ERROR_CODES.reportNotFound });
    this.assertCanEdit(row, actor);
    return this.db.$transaction(async (tx) => {
      // Отчёт стал личным → убрать его из ОБЩИХ дашбордов (иначе коллеги видели бы дыру)
      if (input.visibility === 'private' && row.visibility === 'shared') await this.detachFromDashboards(tx, id, 'shared');
      const updated = await tx.analyticsReport.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.query !== undefined ? { query: input.query as unknown as Prisma.InputJsonValue } : {}),
          ...(input.viz !== undefined ? { viz: input.viz } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        },
      });
      return this.reportDto(updated, actor);
    });
  }

  async deleteReport(actor: PlatformActor, id: string): Promise<void> {
    const row = await this.db.analyticsReport.findFirst({ where: { id, ...this.visibleWhere(actor) } });
    if (!row) throw notFound('analytics.report_not_found', undefined, { code: ANALYTICS_ERROR_CODES.reportNotFound });
    this.assertCanEdit(row, actor);
    await this.db.$transaction(async (tx) => {
      await this.detachFromDashboards(tx, id, null);
      await tx.analyticsReport.delete({ where: { id } });
    });
  }

  /** Убрать плитки отчёта из дашбордов (всех или только общих). */
  private async detachFromDashboards(tx: Prisma.TransactionClient, reportId: string, visibility: AnalyticsVisibility | null): Promise<void> {
    const boards = await tx.$queryRaw<Array<{ id: string; tiles: unknown }>>`
      SELECT id, tiles FROM analytics_dashboards
      WHERE tiles @> ${JSON.stringify([{ reportId }])}::jsonb
        ${visibility ? Prisma.sql`AND visibility = ${visibility}` : Prisma.empty}`;
    for (const b of boards) {
      const tiles = (Array.isArray(b.tiles) ? (b.tiles as AnalyticsTile[]) : []).filter((t) => t.reportId !== reportId);
      await tx.analyticsDashboard.update({ where: { id: b.id }, data: { tiles: tiles as unknown as Prisma.InputJsonValue } });
    }
  }

  // ---- Дашборды ----

  private tilesOf(d: AnalyticsDashboard): AnalyticsTile[] {
    const raw = Array.isArray(d.tiles) ? d.tiles : [];
    return raw.map((t) => analyticsTileSchema.safeParse(t)).filter((p) => p.success).map((p) => p.data as AnalyticsTile);
  }

  private dashboardDto(d: AnalyticsDashboard, actor: PlatformActor): AnalyticsDashboardDto {
    return {
      id: d.id,
      title: d.title,
      systemKey: d.systemKey,
      tiles: this.tilesOf(d),
      visibility: d.visibility as AnalyticsVisibility,
      createdBy: d.createdBy,
      canEdit: !d.systemKey && (d.createdBy === actor.userId || canManage(actor)),
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  /**
   * Плитки ссылаются только на видимые актору отчёты; у ОБЩЕГО дашборда — только на
   * общие отчёты (личный черновик на общем дашборде был бы дырой у всех, кроме автора).
   */
  private async assertTiles(actor: PlatformActor, tiles: AnalyticsTile[], visibility: AnalyticsVisibility): Promise<void> {
    const ids = [...new Set(tiles.map((t) => t.reportId))];
    if (!ids.length) return;
    const rows = await this.db.analyticsReport.findMany({ where: { id: { in: ids }, ...this.visibleWhere(actor) }, select: { id: true, visibility: true } });
    if (rows.length !== ids.length) throw notFound('analytics.report_not_found', undefined, { code: ANALYTICS_ERROR_CODES.reportNotFound });
    if (visibility === 'shared' && rows.some((r) => r.visibility !== 'shared')) {
      throw badRequest('analytics.private_tile', undefined, { code: 'analytics.private_tile' });
    }
  }

  async listDashboards(actor: PlatformActor): Promise<AnalyticsDashboardDto[]> {
    const rows = await this.db.analyticsDashboard.findMany({ where: this.visibleWhere(actor), orderBy: [{ updatedAt: 'desc' }], take: 200 });
    const order = (d: AnalyticsDashboard) => (d.systemKey ? SYSTEM_DASHBOARD_ORDER.indexOf(d.systemKey) : 1000);
    return rows.sort((a, b) => order(a) - order(b)).map((d) => this.dashboardDto(d, actor));
  }

  async getDashboard(actor: PlatformActor, idOrKey: string): Promise<AnalyticsDashboardDetailDto> {
    const bySystemKey = !/^[0-9a-f-]{36}$/i.test(idOrKey);
    const row = await this.db.analyticsDashboard.findFirst({
      where: { ...(bySystemKey ? { systemKey: idOrKey } : { id: idOrKey }), ...this.visibleWhere(actor) },
    });
    if (!row) throw notFound('analytics.dashboard_not_found', undefined, { code: ANALYTICS_ERROR_CODES.dashboardNotFound });
    const dto = this.dashboardDto(row, actor);
    const reports = await this.db.analyticsReport.findMany({
      where: { id: { in: dto.tiles.map((t) => t.reportId) }, ...this.visibleWhere(actor) },
    });
    const visible = new Set(reports.map((r) => r.id));
    return { ...dto, tiles: dto.tiles.filter((t) => visible.has(t.reportId)), reports: reports.map((r) => this.reportDto(r, actor)) };
  }

  async createDashboard(actor: PlatformActor, input: AnalyticsDashboardCreateInput): Promise<AnalyticsDashboardDto> {
    await this.assertTiles(actor, input.tiles, input.visibility);
    const row = await this.db.analyticsDashboard.create({
      data: {
        title: input.title,
        tiles: input.tiles as unknown as Prisma.InputJsonValue,
        visibility: input.visibility,
        createdBy: actor.userId,
      },
    });
    return this.dashboardDto(row, actor);
  }

  async updateDashboard(actor: PlatformActor, id: string, input: AnalyticsDashboardUpdateInput): Promise<AnalyticsDashboardDto> {
    const row = await this.db.analyticsDashboard.findFirst({ where: { id, ...this.visibleWhere(actor) } });
    if (!row) throw notFound('analytics.dashboard_not_found', undefined, { code: ANALYTICS_ERROR_CODES.dashboardNotFound });
    this.assertCanEdit(row, actor);
    const visibility = input.visibility ?? (row.visibility as AnalyticsVisibility);
    await this.assertTiles(actor, input.tiles ?? this.tilesOf(row), visibility);
    const updated = await this.db.analyticsDashboard.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.tiles !== undefined ? { tiles: input.tiles as unknown as Prisma.InputJsonValue } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
    });
    return this.dashboardDto(updated, actor);
  }

  async deleteDashboard(actor: PlatformActor, id: string): Promise<void> {
    const row = await this.db.analyticsDashboard.findFirst({ where: { id, ...this.visibleWhere(actor) } });
    if (!row) throw notFound('analytics.dashboard_not_found', undefined, { code: ANALYTICS_ERROR_CODES.dashboardNotFound });
    this.assertCanEdit(row, actor);
    await this.db.analyticsDashboard.delete({ where: { id } });
  }
}
