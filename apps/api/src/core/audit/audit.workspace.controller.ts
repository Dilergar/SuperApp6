import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUDIT_ERROR_CODES, auditOrgFilterKeys, orgAuditExportSchema, orgSecurityEventsQuerySchema, type OrgSecurityOverviewDto } from '@superapp/shared';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import { AuditExportService } from './audit.export';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { notFound } from '../../shared/errors/api-error';
import { AuditQueryService } from './audit.query.service';
import { AuditWorkspaceAccess } from './audit.workspace-access';

/**
 * Журнал безопасности организации (core/audit): входы сотрудников с новых устройств, роли,
 * ключи и интеграции, выгрузки, согласия — только события СВОЕГО контекста (`vis_workspace`
 * и `workspace_id = :id` в проекции, фильтр обойти её не может); личные входы людей — никогда.
 * Право — owner/admin организации; ключ API сюда не пускается (`@NoApiKeys`): журнал
 * безопасности читает человек, а не интеграция (стрим в SIEM — вебхуки `security.*`).
 * Окно — тариф `audit.retentionDays`.
 */
@ApiTags('Security')
@ApiBearerAuth()
@NoApiKeys()
@Controller('workspaces/:workspaceId/security')
export class AuditWorkspaceController {
  constructor(
    private readonly query: AuditQueryService,
    private readonly access: AuditWorkspaceAccess,
    private readonly exporter: AuditExportService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Security log of the organization: plan window, export and stream availability' })
  async overview(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    await this.access.assertManager(user.sub, workspaceId);
    const data: OrgSecurityOverviewDto = await this.access.overview(workspaceId);
    return { success: true, data };
  }

  @Get('events')
  @ApiOperation({ summary: 'Security log of the organization (plan window; filters by category, actor, period, outcome)' })
  async events(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: unknown) {
    await this.access.assertManager(user.sub, workspaceId);
    const f = orgSecurityEventsQuerySchema.parse(q ?? {});
    const viewer = { kind: 'workspace' as const, workspaceId, retentionDays: await this.access.retentionDays(workspaceId) };
    const data = await this.query.query(viewer, {
      keys: auditOrgFilterKeys(f.filter ?? 'all'),
      actorId: f.actorId,
      from: f.from ? new Date(f.from) : undefined,
      to: f.to ? new Date(f.to) : undefined,
      op: f.op,
      outcome: f.outcome,
      cursor: f.cursor,
      limit: f.limit,
    });
    return { success: true, data };
  }

  /**
   * Заказать выгрузку журнала (NDJSON/CSV) на Диск организации, папка «Безопасность».
   * Тариф `audit.export` (402), окно тарифа, 5 в сутки; сама выгрузка — джоб, готовность —
   * уведомлением. Ключ повтора обязателен: двойной клик не должен заказать два файла.
   */
  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent({ required: true })
  @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Export the organization security log to the organization Drive (NDJSON/CSV)' })
  async export(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: unknown) {
    const input = orgAuditExportSchema.parse(body ?? {});
    return { success: true, data: await this.exporter.requestOrg(user, workspaceId, input) };
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'One event of the organization security log' })
  async event(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id') id: string) {
    await this.access.assertManager(user.sub, workspaceId);
    const viewer = { kind: 'workspace' as const, workspaceId, retentionDays: await this.access.retentionDays(workspaceId) };
    const dto = await this.query.getOne(viewer, id);
    if (!dto) throw notFound('audit.event_not_found', undefined, { code: AUDIT_ERROR_CODES.eventNotFound });
    return { success: true, data: dto };
  }
}
