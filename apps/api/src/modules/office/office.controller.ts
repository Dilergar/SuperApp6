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
  @ApiOperation({ summary: 'The live meetings of the organization (+ the ones running now, with their participants)' })
  async list(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.office.list(user.sub, id) };
  }

  @Get('history')
  @ApiOperation({ summary: 'The history of finished meetings (cursor; the chat of a meeting is the home of the future transcripts)' })
  async history(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    return { success: true, data: await this.office.history(user.sub, id, cursor) };
  }

  @Post('rooms')
  @ApiOperation({ summary: 'Create a meeting (the name is optional — «Meeting DD.MM HH:MM» by default)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = createOfficeRoomSchema.parse(body ?? {});
    return { success: true, data: await this.office.create(user.sub, id, dto) };
  }

  @Get('rooms/:roomId')
  @ApiOperation({ summary: 'A meeting (+ the live call, my role)' })
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
  ) {
    return { success: true, data: await this.office.getOne(user.sub, id, roomId) };
  }

  @Post('rooms/:roomId/invite')
  @ApiOperation({ summary: 'Invite employees (a notification + the members of the meeting chat)' })
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
  @ApiOperation({ summary: 'End the meeting for everyone (the host ∥ Manager+)' })
  async end(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
  ) {
    await this.office.end(user.sub, id, roomId);
    return { success: true };
  }
}
