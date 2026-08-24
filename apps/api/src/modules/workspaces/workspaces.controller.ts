import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WorkspacesService } from './workspaces.service';
import {
  CurrentUser,
  type JwtPayload,
} from '../../shared/decorators/current-user.decorator';
import {
  createWorkspaceSchema,
  updateWorkspaceProfileSchema,
  transferOwnershipSchema,
  inviteWorkspaceMemberSchema,
  updateWorkspaceMemberSchema,
  workspaceRequisitesSchema,
  createBankAccountSchema,
  updateBankAccountSchema,
} from '@superapp/shared';

@ApiTags('Workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(private workspaces: WorkspacesService) {}

  // ----- Workspaces -----

  @Get()
  @ApiOperation({ summary: 'Мои организации (для переключателя)' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.workspaces.listMyWorkspaces(user.sub);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Создать организацию' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = createWorkspaceSchema.parse(body);
    const ws = await this.workspaces.createWorkspace(user.sub, data);
    return { success: true, data: ws };
  }

  @Get('archived')
  @ApiOperation({ summary: 'Архив: мои деактивированные организации (владелец)' })
  async listArchived(@CurrentUser() user: JwtPayload) {
    const data = await this.workspaces.listArchivedWorkspaces(user.sub);
    return { success: true, data };
  }

  /**
   * Прогнать ретеншн архива немедленно (удаление созревшего + предупреждения за 7/3/1
   * день) — полигон verify-workspace-restore.cjs: ждать ночного крона тест не может.
   * Только при NODE_ENV=development, как /jobs/dev/*: в любом другом окружении ручки
   * будто нет.
   */
  @Post('dev/purge-archives')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'DEV: прогнать ретеншн архива сейчас (только development)' })
  async devPurgeArchives(@Body() body?: { workspaceId?: string }) {
    if (process.env.NODE_ENV !== 'development') throw new NotFoundException();
    // Полигон КЭДО: purge КОНКРЕТНОЙ организации сейчас (проверка «личный архив
    // переживает purge» не может ждать 90 дней ретеншна). Только development.
    if (body?.workspaceId) {
      await this.workspaces.purgeWorkspace(String(body.workspaceId));
      return { success: true, data: { purged: 1, warned: 0 } };
    }
    const purged = await this.workspaces.purgeExpiredArchives();
    const warned = await this.workspaces.warnExpiringArchives();
    return { success: true, data: { purged, warned } };
  }

  // ----- Incoming invitations (must precede ':id' routes) -----

  @Get('invitations/incoming')
  @ApiOperation({ summary: 'Мои входящие приглашения в организации' })
  async incomingInvitations(@CurrentUser() user: JwtPayload) {
    const data = await this.workspaces.listIncomingInvitations(user.sub);
    return { success: true, data };
  }

  @Post('invitations/:invId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Принять приглашение в организацию' })
  async acceptInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('invId') invId: string,
  ) {
    const data = await this.workspaces.acceptInvitation(user.sub, invId);
    return { success: true, data };
  }

  @Post('invitations/:invId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отклонить приглашение в организацию' })
  async rejectInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('invId') invId: string,
  ) {
    await this.workspaces.rejectInvitation(user.sub, invId);
    return { success: true };
  }

  // ----- Single workspace -----

  @Get(':id')
  @ApiOperation({ summary: 'Организация (с моей ролью)' })
  async get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.workspaces.getWorkspace(user.sub, id);
    return { success: true, data };
  }

  // ----- Реквизиты (блок «Анкеты компании»: юрформа, БИН, банк, директор) -----

  @Get(':id/requisites')
  @ApiOperation({ summary: 'Реквизиты организации + банковские счета (сотрудникам — по флагу видимости)' })
  async getRequisites(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.workspaces.getRequisites(user.sub, id);
    return { success: true, data };
  }

  @Patch(':id/requisites')
  @ApiOperation({ summary: 'Обновить реквизиты (admin+; null очищает поле)' })
  async updateRequisites(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = workspaceRequisitesSchema.parse(body);
    const data = await this.workspaces.updateRequisites(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/requisites/accounts')
  @ApiOperation({ summary: 'Добавить банковский счёт (admin+; первый становится основным)' })
  async addBankAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = createBankAccountSchema.parse(body);
    const data = await this.workspaces.addBankAccount(user.sub, id, dto);
    return { success: true, data };
  }

  @Patch(':id/requisites/accounts/:accId')
  @ApiOperation({ summary: 'Изменить банковский счёт / назначить основным (admin+)' })
  async updateBankAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('accId') accId: string,
    @Body() body: unknown,
  ) {
    const dto = updateBankAccountSchema.parse(body);
    const data = await this.workspaces.updateBankAccount(user.sub, id, accId, dto);
    return { success: true, data };
  }

  @Delete(':id/requisites/accounts/:accId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить банковский счёт (admin+)' })
  async removeBankAccount(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('accId') accId: string,
  ) {
    const data = await this.workspaces.removeBankAccount(user.sub, id, accId);
    return { success: true, data };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Обновить профиль организации (admin+)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = updateWorkspaceProfileSchema.parse(body);
    const ws = await this.workspaces.updateWorkspace(user.sub, id, data);
    return { success: true, data: ws };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Деактивировать организацию (владелец)' })
  async deactivate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.workspaces.deactivateWorkspace(user.sub, id);
    return { success: true };
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Восстановить деактивированную организацию (владелец)' })
  async restore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.workspaces.restoreWorkspace(user.sub, id);
    return { success: true };
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Передать владение (владелец)' })
  async transfer(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = transferOwnershipSchema.parse(body);
    await this.workspaces.transferOwnership(user.sub, id, data.toUserId);
    return { success: true };
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выйти из организации (не владелец)' })
  async leave(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.workspaces.leaveWorkspace(user.sub, id);
    return { success: true };
  }

  // ----- Members -----

  @Get(':id/members')
  @ApiOperation({ summary: 'Сотрудники организации' })
  async members(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.workspaces.listMembers(user.sub, id);
    return { success: true, data };
  }

  @Patch(':id/members/:userId')
  @ApiOperation({ summary: 'Изменить роль сотрудника (admin+; админа — только владелец)' })
  async updateMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() body: unknown,
  ) {
    const data = updateWorkspaceMemberSchema.parse(body);
    await this.workspaces.updateMember(user.sub, id, targetUserId, data);
    return { success: true };
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Уволить сотрудника (admin+)' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    await this.workspaces.removeMember(user.sub, id, targetUserId);
    return { success: true };
  }

  // ----- Outgoing invitations -----

  @Post(':id/invitations')
  @ApiOperation({ summary: 'Нанять по номеру — всегда в Стажёра (manager+)' })
  async invite(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = inviteWorkspaceMemberSchema.parse(body);
    const inv = await this.workspaces.inviteMember(user.sub, id, data);
    return { success: true, data: inv };
  }

  @Get(':id/invitations')
  @ApiOperation({ summary: 'Исходящие приглашения организации (manager+)' })
  async outgoingInvitations(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const data = await this.workspaces.listOutgoingInvitations(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/invitations/:invId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить приглашение (manager+)' })
  async cancelInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('invId') invId: string,
  ) {
    await this.workspaces.cancelInvitation(user.sub, id, invId);
    return { success: true };
  }
}
