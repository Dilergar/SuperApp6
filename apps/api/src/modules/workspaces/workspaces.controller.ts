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
  @ApiOperation({ summary: 'Изменить роль/должность сотрудника (admin+)' })
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
  @ApiOperation({ summary: 'Пригласить сотрудника по номеру (admin+)' })
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
  @ApiOperation({ summary: 'Исходящие приглашения организации (admin+)' })
  async outgoingInvitations(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const data = await this.workspaces.listOutgoingInvitations(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/invitations/:invId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить приглашение (admin+)' })
  async cancelInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('invId') invId: string,
  ) {
    await this.workspaces.cancelInvitation(user.sub, id, invId);
    return { success: true };
  }
}
