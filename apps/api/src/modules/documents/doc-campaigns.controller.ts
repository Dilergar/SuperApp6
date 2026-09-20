import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createCampaignSchema } from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
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
  @ApiOperation({ summary: 'The acknowledgement campaigns of the organization (Manager and above)' })
  async list(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.campaigns.list(user.sub, workspaceId);
    return { success: true, data };
  }

  // Кампания = рассылка ВСЕЙ аудитории (клик или SMS за деньги). Повтор — вторая
  // такая же, и «отозвать» её у получателей уже нечем.
  @Idempotent({ required: true })
  @Post()
  @ApiOperation({ summary: 'Start an acknowledgement campaign (Manager and above)' })
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
  @ApiOperation({ summary: 'A campaign with the analytics down to a person (Manager and above)' })
  async detail(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const data = await this.campaigns.detail(user.sub, workspaceId, campaignId);
    return { success: true, data };
  }

  @Post(':campaignId/sweep')
  @ApiOperation({ summary: 'Catch up with the audience now (standing: whoever is hired later gets the task, Manager and above)' })
  async sweep(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    await this.campaigns.sweepNow(user.sub, workspaceId, campaignId);
    return { success: true, data: { swept: true } };
  }

  @Post(':campaignId/cancel')
  @ApiOperation({ summary: 'Cancel a campaign (Manager and above)' })
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    await this.campaigns.cancel(user.sub, workspaceId, campaignId);
    return { success: true, data: { cancelled: true } };
  }

  @Post(':campaignId/targets/:userId/sms-failed')
  @ApiOperation({ summary: 'Mark the SMS as undelivered (a separate outcome, Manager and above)' })
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
  @ApiOperation({ summary: 'Acknowledged (the click mode; records the sha256 and the chronicle)' })
  async acknowledge(@CurrentUser() user: JwtPayload, @Param('campaignId') campaignId: string) {
    await this.campaigns.markAcknowledged(campaignId, user.sub);
    return { success: true, data: { acknowledged: true } };
  }

  @Get('my-task')
  @ApiOperation({ summary: 'My campaign task for the document (the button on the card)' })
  async myTask(@CurrentUser() user: JwtPayload, @Query('documentId') documentId: string) {
    const data = await this.campaigns.myTaskForDocument(user.sub, String(documentId ?? ''));
    return { success: true, data };
  }
}
