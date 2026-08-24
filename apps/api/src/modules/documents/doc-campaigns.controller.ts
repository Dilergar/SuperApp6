import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createCampaignSchema } from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { DocCampaignsService } from './doc-campaigns.service';

/**
 * Кампании ознакомления (КЭДО, Этап 5). База пути СВОЯ (`doc-campaigns`), а не
 * `documents/campaigns`: у DocumentsController стоит catch-all `:documentId`, и
 * слово «campaigns» стало бы идентификатором документа (ловушка «статические
 * пути до :id» — здесь она неустранима порядком, потому что контроллеры разные).
 */
@ApiTags('doc-campaigns')
@Controller('workspaces/:workspaceId/doc-campaigns')
export class DocCampaignsController {
  constructor(private readonly campaigns: DocCampaignsService) {}

  @Get()
  @ApiOperation({ summary: 'Кампании ознакомления организации (Менеджер+)' })
  async list(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.campaigns.list(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Запустить кампанию ознакомления (Менеджер+)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createCampaignSchema.parse(body);
    const data = await this.campaigns.create(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Get(':campaignId')
  @ApiOperation({ summary: 'Кампания с аналитикой до человека (Менеджер+)' })
  async detail(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const data = await this.campaigns.detail(user.sub, workspaceId, campaignId);
    return { success: true, data };
  }

  @Post(':campaignId/sweep')
  @ApiOperation({ summary: 'Догнать аудиторию сейчас (standing: принятый позже получает задание, Менеджер+)' })
  async sweep(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    await this.campaigns.sweepNow(user.sub, workspaceId, campaignId);
    return { success: true, data: { swept: true } };
  }

  @Post(':campaignId/cancel')
  @ApiOperation({ summary: 'Отменить кампанию (Менеджер+)' })
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    await this.campaigns.cancel(user.sub, workspaceId, campaignId);
    return { success: true, data: { cancelled: true } };
  }

  @Post(':campaignId/targets/:userId/sms-failed')
  @ApiOperation({ summary: 'Отметить: SMS не доставлена (отдельный исход, Менеджер+)' })
  async smsFailed(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @Param('userId') userId: string,
  ) {
    await this.campaigns.markSmsFailed(user.sub, workspaceId, campaignId, userId);
    return { success: true, data: { marked: true } };
  }
}

/** Личные ручки адресата: отметка «Ознакомлен» и задание по документу */
@ApiTags('doc-campaigns')
@Controller('doc-campaigns')
export class DocCampaignsPersonalController {
  constructor(private readonly campaigns: DocCampaignsService) {}

  @Post(':campaignId/acknowledge')
  @ApiOperation({ summary: 'Ознакомлен (click-режим; фиксирует sha256 и хронику)' })
  async acknowledge(@CurrentUser() user: JwtPayload, @Param('campaignId') campaignId: string) {
    await this.campaigns.markAcknowledged(campaignId, user.sub);
    return { success: true, data: { acknowledged: true } };
  }

  @Get('my-task')
  @ApiOperation({ summary: 'Моё задание кампании по документу (кнопка на карточке)' })
  async myTask(@CurrentUser() user: JwtPayload, @Query('documentId') documentId: string) {
    const data = await this.campaigns.myTaskForDocument(user.sub, String(documentId ?? ''));
    return { success: true, data };
  }
}
