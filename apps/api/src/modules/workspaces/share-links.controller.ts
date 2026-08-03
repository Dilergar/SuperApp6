import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { bulkRevokeSchema, mineShareLinksQuerySchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ShareLinksService } from '../../core/share-links/share-links.service';
import { WorkspacesService } from './workspaces.service';

/**
 * «Ссылки организации» — всё, что раздала наружу вся команда (core/share-links).
 *
 * Живёт в модуле workspaces, а не в движке — по образцу «Журнала организации»
 * (`journal.controller.ts` на core/chatter): понятие «роль в организации» принадлежит
 * этому модулю, и движок ссылок не должен знать ни ролей, ни лестницы. Движку остаются
 * системные методы со скоупом, право на который проверил вызывающий.
 *
 * Гейт — Менеджер и выше: раздавать наружу на диске организации может он же, значит и
 * закрывать чужое вправе он. Отзыв только СУЖАЕТ доступ, поэтому право видеть список и
 * право закрыть его строки совпадают. Ради этого раздел и заводится: уволенный менеджер
 * оставлял после себя ссылки, которые некому было закрыть — «Мои ссылки» показывают
 * только свои, а пообъектный обход требует помнить все объекты.
 */
@ApiTags('Workspaces')
@ApiBearerAuth()
@Controller('workspaces/:id/share-links')
export class WorkspaceShareLinksController {
  constructor(
    private readonly links: ShareLinksService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Ссылки наружу всей организации (Менеджер+)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    await this.workspaces.assertManagerPlus(user.sub, id);
    const q = mineShareLinksQuerySchema.parse(query ?? {});
    const { items, nextCursor, actors } = await this.links.listForWorkspace(id, q);
    return { success: true, data: items, nextCursor, actors };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Сводка: действующих ссылок, объектов, открытий за период' })
  async stats(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.workspaces.assertManagerPlus(user.sub, id);
    return { success: true, data: await this.links.statsForWorkspace(id) };
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отозвать пачку ссылок организации, в том числе чужих (Менеджер+)' })
  async revoke(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    await this.workspaces.assertManagerPlus(user.sub, id);
    const { ids } = bulkRevokeSchema.parse(body);
    const revoked = await this.links.revokeForWorkspace(user.sub, id, ids);
    return { success: true, data: { revoked } };
  }
}
