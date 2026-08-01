import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createShareLinkSchema,
  listShareLinksQuerySchema,
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
  @ApiOperation({ summary: 'Создать гостевую ссылку на объект' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createShareLinkSchema.parse(body);
    const data = await this.links.create(user.sub, dto);
    return { success: true, data };
  }

  @Get()
  @ApiOperation({ summary: 'Ссылки объекта (включая отозванные — это история раздачи)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = listShareLinksQuerySchema.parse(query);
    const { items, total } = await this.links.list(user.sub, q.refType, q.refId);
    return { success: true, data: items, total };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Изменить подпись, срок, пароль или лимит открытий' })
  async update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = updateShareLinkSchema.parse(body);
    const data = await this.links.update(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Отозвать ссылку (идемпотентно)' })
  async revoke(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.links.revoke(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/visits')
  @ApiOperation({ summary: 'Журнал визитов: когда открывали, с какого адреса' })
  async visits(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const q = shareVisitsQuerySchema.parse(query);
    const { items, nextCursor } = await this.links.listVisits(user.sub, id, q);
    return { success: true, data: items, nextCursor };
  }
}
