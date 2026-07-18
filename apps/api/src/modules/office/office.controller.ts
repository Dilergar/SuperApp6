import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createOfficeRoomSchema, inviteOfficeRoomSchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { OfficeService } from './office.service';

/**
 * «Виртуальный офис» (B2B) — тонкий контроллер (Zod → сервис, AI-ready по Принципу 4).
 * Path-based изоляция (паттерн staff/processes): «/workspaces/:id/office», роль
 * проверяет сервис. Join-эндпоинта НЕТ — вход в звонок идёт через генерик движка
 * POST /calls/token {refType:'office_room', refId:<roomId>}.
 */
@ApiTags('Office')
@ApiBearerAuth()
@Controller('workspaces/:id/office')
export class OfficeController {
  constructor(private readonly office: OfficeService) {}

  @Get()
  @ApiOperation({ summary: 'Активные встречи организации (+«идёт сейчас» с участниками)' })
  async list(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.office.list(user.sub, id) };
  }

  @Get('history')
  @ApiOperation({ summary: 'История завершённых встреч (cursor; чат встречи — дом транскрипций Ф3)' })
  async history(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    return { success: true, data: await this.office.history(user.sub, id, cursor) };
  }

  @Post('rooms')
  @ApiOperation({ summary: 'Создать встречу (имя опционально — «Встреча ДД.ММ ЧЧ:ММ»)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = createOfficeRoomSchema.parse(body ?? {});
    return { success: true, data: await this.office.create(user.sub, id, dto) };
  }

  @Get('rooms/:roomId')
  @ApiOperation({ summary: 'Встреча (+живой созвон, моя роль)' })
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
  ) {
    return { success: true, data: await this.office.getOne(user.sub, id, roomId) };
  }

  @Post('rooms/:roomId/invite')
  @ApiOperation({ summary: 'Пригласить сотрудников (уведомление + участники чата встречи)' })
  async invite(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = inviteOfficeRoomSchema.parse(body);
    return { success: true, data: await this.office.invite(user.sub, id, roomId, dto) };
  }

  @Post('rooms/:roomId/end')
  @ApiOperation({ summary: 'Завершить встречу для всех (организатор ∥ Менеджер+)' })
  async end(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
  ) {
    await this.office.end(user.sub, id, roomId);
    return { success: true };
  }
}
