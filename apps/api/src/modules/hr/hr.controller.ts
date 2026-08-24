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
  @ApiOperation({ summary: 'ZIP реестра за период: штампованные PDF + протоколы + опись (Менеджер+)' })
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
  @ApiOperation({ summary: 'ZIP личного дела сотрудника (Менеджер+)' })
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
  @ApiOperation({ summary: 'Сводный экран «Кадровые сроки» (Менеджер+)' })
  async deadlines(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.hr.getDeadlines(user.sub, workspaceId);
    return { success: true, data };
  }

  @Get('deadlines/count')
  @ApiOperation({ summary: 'Счётчик «горит» для бейджа пункта «Сотрудники»' })
  async deadlinesCount(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = { count: await this.hr.deadlinesCount(user.sub, workspaceId) };
    return { success: true, data };
  }

  @Get('roster-overview')
  @ApiOperation({ summary: 'Кадровая сводка ростера: фильтры «нет договора / расхождение» (Менеджер+)' })
  async rosterOverview(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.hr.rosterOverview(user.sub, workspaceId);
    return { success: true, data };
  }

  // ---- ЕСУТД ----

  @Get('esutd')
  @ApiOperation({ summary: 'Очередь сдачи в ЕСУТД (Менеджер+)' })
  async esutd(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query('status') status?: string,
  ) {
    const data = await this.hr.listEsutd(user.sub, workspaceId, status);
    return { success: true, data };
  }

  @Get('esutd/:submissionId/payload')
  @ApiOperation({ summary: '«Скопировать сведения» — снимок по перечню Правил № 353' })
  async esutdPayload(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('submissionId') submissionId: string,
  ) {
    const data = await this.hr.esutdPayload(user.sub, workspaceId, submissionId);
    return { success: true, data };
  }

  @Post('esutd/:submissionId/submitted')
  @ApiOperation({ summary: 'Отметить сданным (ручной путь; считает окно исправления 30 РД)' })
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
  @ApiOperation({ summary: 'Отметить: сдача не требуется' })
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
  @ApiOperation({ summary: 'Каталог платформенных бланков РК с состоянием установки (Менеджер+)' })
  async libraryList(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.library.list(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('library/install')
  @ApiOperation({ summary: 'Установить бланк: вид + шаблон + ОПУБЛИКОВАННЫЙ маршрут (мастер)' })
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

  @Post('batches')
  @ApiOperation({ summary: 'Массовое кадровое действие по аудитории (потолок 500, Менеджер+)' })
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
  @ApiOperation({ summary: 'Прогресс массовой операции' })
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
  @ApiOperation({ summary: 'Мои действия-заявления (отзыв — ст. 56 п. 4 ТК РК)' })
  async myActions(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.actions.listMine(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('actions')
  @ApiOperation({ summary: 'Начать кадровое действие: приказ + маршрут (Менеджер+)' })
  async createAction(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createHrActionSchema.parse(body);
    const data = await this.actions.createAction(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Post('actions/:actionId/cancel')
  @ApiOperation({ summary: 'Отменить действие (Менеджер+; работник — своё увольнение, ст. 56 п. 4)' })
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
  @ApiOperation({ summary: 'Карточка человека: факт + договор + действия + расхождение' })
  async memberCard(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    const data = await this.hr.getMemberCard(user.sub, workspaceId, userId);
    return { success: true, data };
  }

  @Put('members/:userId/employment')
  @ApiOperation({ summary: 'Трудовая карточка: завести/править (Менеджер+)' })
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
  @ApiOperation({ summary: 'Личный архив: подписанное, ознакомленное, вручённое — бессрочно' })
  async myDocuments(@CurrentUser() user: JwtPayload) {
    const data = await this.hr.listMyDocs(user.sub);
    return { success: true, data };
  }
}
