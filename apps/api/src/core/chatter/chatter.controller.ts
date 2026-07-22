import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { chronicleQuerySchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ChatterService } from './chatter.service';

/**
 * core/chatter — тонкий контроллер (Zod → сервис, AI-ready по Принципу 4).
 * Доступ решает canView-резолвер потребителя (ChatterRefRegistry).
 * «Журнал организации» — path-based эндпоинт в модуле workspaces.
 */
@ApiTags('Chatter')
@ApiBearerAuth()
@Controller('chatter')
export class ChatterController {
  constructor(private readonly chatter: ChatterService) {}

  @Get(':refType/:refId')
  @ApiOperation({ summary: 'Хроника записи (кто/что/когда + «было → стало»; keyset-курсор)' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('refType') refType: string,
    @Param('refId') refId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const q = chronicleQuerySchema.parse(query ?? {});
    return { success: true, data: await this.chatter.list(user.sub, refType, refId, q) };
  }
}
