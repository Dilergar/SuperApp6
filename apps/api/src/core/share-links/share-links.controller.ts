import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  bulkRevokeSchema,
  createShareLinkSchema,
  listShareLinksQuerySchema,
  mineShareLinksQuerySchema,
  shareVisitsQuerySchema,
  updateShareLinkSchema,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ShareLinksService } from './share-links.service';

/**
 * Управление гостевыми ссылками (для тех, кто внутри платформы). Тонкий контроллер:
 * Zod → сервис, право решает резолвер потребителя.
 */
@ApiTags('ShareLinks')
@ApiBearerAuth()
@Controller('share-links')
export class ShareLinksController {
  constructor(private readonly links: ShareLinksService) {}

  @Post()
  @ApiOperation({ summary: 'Create a guest link to an item' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createShareLinkSchema.parse(body);
    const data = await this.links.create(user.sub, dto);
    return { success: true, data };
  }

  @Get()
  @ApiOperation({ summary: 'The links of an item (revoked ones included — this is the sharing history)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = listShareLinksQuerySchema.parse(query);
    return { success: true, data: await this.links.list(user.sub, q.refType, q.refId) };
  }

  /**
   * ВАЖЕН ПОРЯДОК: статические пути объявлены ДО `:id`, иначе Nest сопоставит
   * `/share-links/mine` с параметром и уйдёт искать ссылку с идентификатором «mine».
   */
  @Get('mine')
  @ApiOperation({ summary: 'Every link of mine from every service — the “My links” section' })
  async mine(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = mineShareLinksQuerySchema.parse(query);
    return { success: true, data: await this.links.listMine(user.sub, q) };
  }

  @Get('mine/stats')
  @ApiOperation({ summary: 'A summary: active links, items and opens over the period' })
  async mineStats(@CurrentUser() user: JwtPayload) {
    const data = await this.links.statsMine(user.sub);
    return { success: true, data };
  }

  @Post('mine/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a batch of my links (the right is authorship, not the rights to the item)' })
  async revokeMine(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { ids } = bulkRevokeSchema.parse(body);
    const revoked = await this.links.revokeMine(user.sub, ids);
    return { success: true, data: { revoked } };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change the label, the deadline, the password or the open limit' })
  async update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = updateShareLinkSchema.parse(body);
    const data = await this.links.update(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke a link (idempotent)' })
  async revoke(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.links.revoke(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the link address, keeping its settings and the visit log' })
  async rotate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.links.rotateToken(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/visits')
  @ApiOperation({ summary: 'The visit log: when it was opened and from which address' })
  async visits(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const q = shareVisitsQuerySchema.parse(query);
    return { success: true, data: await this.links.listVisits(user.sub, id, q) };
  }
}
