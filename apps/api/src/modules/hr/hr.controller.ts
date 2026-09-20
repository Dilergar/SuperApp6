import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  createHrActionSchema,
  createHrBatchSchema,
  esutdMarkSubmittedSchema,
  hrLibraryInstallSchema,
  upsertEmploymentSchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import { HrService } from './hr.service';
import { HrActionsService } from './hr-actions.service';
import { HrLibraryService } from './hr-library.service';
import { HrExportService } from './hr-export.service';

/**
 * КЭДО — тонкий контроллер (Zod → сервис, AI-ready). Путь скоупится организацией
 * (паттерн Документооборота): кадровые данные всегда принадлежат конкретной
 * организации, и адрес обязан это показывать.
 *
 * ⚠️ Статические пути объявлены ДО параметрических (ловушка Nest «inbox до :id»).
 */
@ApiTags('hr')
@Controller('workspaces/:workspaceId/hr')
export class HrController {
  constructor(
    private readonly hr: HrService,
    private readonly actions: HrActionsService,
    private readonly library: HrLibraryService,
    private readonly exporter: HrExportService,
  ) {}

  // ---- Выгрузка для инспекции (ст. 62 ЦК: документ живёт вне системы) ----

  @Get('export/registry')
  @ApiOperation({ summary: 'ZIP of the register for a period: stamped PDFs, signing logs and an inventory (manager+)' })
  async exportRegistry(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query('docTypeId') docTypeId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    await this.exporter.exportRegistry(user.sub, workspaceId, { docTypeId, from, to }, res);
  }

  @Get('export/personal-file/:userId')
  @ApiOperation({ summary: 'ZIP of an employee personal file (manager+)' })
  async exportPersonalFile(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Res() res: Response,
  ) {
    await this.exporter.exportPersonalFile(user.sub, workspaceId, userId, res);
  }

  // ---- Сводные экраны ----

  @Get('deadlines')
  @ApiOperation({ summary: 'Summary screen «HR deadlines» (manager+)' })
  async deadlines(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.hr.getDeadlines(user.sub, workspaceId);
    return { success: true, data };
  }

  @Get('deadlines/count')
  @ApiOperation({ summary: 'Burning counter for the «Employees» menu badge' })
  async deadlinesCount(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = { count: await this.hr.deadlinesCount(user.sub, workspaceId) };
    return { success: true, data };
  }

  @Get('roster-overview')
  @ApiOperation({ summary: 'HR overview of the roster: «no contract / mismatch» filters (manager+)' })
  async rosterOverview(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.hr.rosterOverview(user.sub, workspaceId);
    return { success: true, data };
  }

  // ---- ЕСУТД ----

  @Get('esutd')
  @ApiOperation({ summary: 'ESUTD filing queue (manager+)' })
  async esutd(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query('status') status?: string,
  ) {
    const data = await this.hr.listEsutd(user.sub, workspaceId, status);
    return { success: true, data };
  }

  @Get('esutd/:submissionId/payload')
  @ApiOperation({ summary: '«Copy the data» — a snapshot following the list of Rules No. 353' })
  async esutdPayload(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('submissionId') submissionId: string,
  ) {
    const data = await this.hr.esutdPayload(user.sub, workspaceId, submissionId);
    return { success: true, data };
  }

  @Post('esutd/:submissionId/submitted')
  @ApiOperation({ summary: 'Mark as filed (manual path; computes the 30 working day correction window)' })
  async esutdSubmitted(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('submissionId') submissionId: string,
    @Body() body: unknown,
  ) {
    const dto = esutdMarkSubmittedSchema.parse(body ?? {});
    const data = await this.hr.markEsutdSubmitted(user.sub, workspaceId, submissionId, dto.externalNumber);
    return { success: true, data };
  }

  @Post('esutd/:submissionId/not-required')
  @ApiOperation({ summary: 'Mark as not requiring a filing' })
  async esutdNotRequired(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('submissionId') submissionId: string,
  ) {
    const data = await this.hr.markEsutdNotRequired(user.sub, workspaceId, submissionId);
    return { success: true, data };
  }

  // ---- Библиотека кадровых бланков ----

  @Get('library')
  @ApiOperation({ summary: 'Catalogue of the platform RK forms with their installation state (manager+)' })
  async libraryList(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.library.list(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('library/install')
  @ApiOperation({ summary: 'Install a form: doc type, template and a PUBLISHED route (wizard)' })
  async libraryInstall(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = hrLibraryInstallSchema.parse(body);
    const data = await this.library.install(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  // ---- Массовые действия ----

  // Кадровое действие — юридический факт в трудовой карточке (приказ, документы,
  // уведомления). Второе такое же «случайно» появиться не должно
  @Idempotent({ required: true })
  @Post('batches')
  @ApiOperation({ summary: 'Bulk HR action over an audience (cap 500, manager+)' })
  async createBatch(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createHrBatchSchema.parse(body);
    const data = await this.actions.createBatch(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Get('batches/:batchId')
  @ApiOperation({ summary: 'Progress of a bulk operation' })
  async getBatch(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('batchId') batchId: string,
  ) {
    const data = await this.actions.getBatch(user.sub, workspaceId, batchId);
    return { success: true, data };
  }

  // ---- Кадровые действия ----

  @Get('actions/mine')
  @ApiOperation({ summary: 'My own applications (withdrawal — Labour Code of the RK, art. 56 (4))' })
  async myActions(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.actions.listMine(user.sub, workspaceId);
    return { success: true, data };
  }

  // Кадровое действие — юридический факт в трудовой карточке (приказ, документы,
  // уведомления). Второе такое же «случайно» появиться не должно
  @Idempotent({ required: true })
  @Post('actions')
  @ApiOperation({ summary: 'Start an HR action: the order and its route (manager+)' })
  async createAction(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createHrActionSchema.parse(body);
    const data = await this.actions.createAction(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  // Кадровое действие — юридический факт в трудовой карточке (приказ, документы,
  // уведомления). Второе такое же «случайно» появиться не должно
  @Idempotent({ required: true })
  @Post('actions/:actionId/cancel')
  @ApiOperation({ summary: 'Cancel an action (manager+; an employee — their own resignation, art. 56 (4))' })
  async cancelAction(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('actionId') actionId: string,
  ) {
    const data = await this.actions.cancelAction(user.sub, workspaceId, actionId);
    return { success: true, data };
  }

  // ---- Страница человека и трудовая карточка ----

  @Get('members/:userId')
  @ApiOperation({ summary: 'Person card: the actual assignment, the contract, the actions and the mismatch' })
  async memberCard(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    const data = await this.hr.getMemberCard(user.sub, workspaceId, userId);
    return { success: true, data };
  }

  @Put('members/:userId/employment')
  @ApiOperation({ summary: 'Employment record: create or edit (manager+)' })
  async upsertEmployment(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const dto = upsertEmploymentSchema.parse(body);
    const data = await this.hr.upsertEmployment(user.sub, workspaceId, userId, dto);
    return { success: true, data };
  }
}

/** Личный контур: «Мои документы» — переживает увольнение и закрытие компании */
@ApiTags('hr')
@Controller('hr')
export class HrPersonalController {
  constructor(private readonly hr: HrService) {}

  @Get('my-documents')
  @ApiOperation({ summary: 'Personal archive: signed, acknowledged and handed over — kept forever' })
  async myDocuments(@CurrentUser() user: JwtPayload) {
    const data = await this.hr.listMyDocs(user.sub);
    return { success: true, data };
  }
}
