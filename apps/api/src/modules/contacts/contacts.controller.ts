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
import { Throttle } from '@nestjs/throttler';
import { ContactsService } from './contacts.service';
import {
  CurrentUser,
  type JwtPayload,
} from '../../shared/decorators/current-user.decorator';
import {
  sendInvitationSchema,
  acceptInvitationSchema,
  updateContactSchema,
  blockUserSchema,
} from '@superapp/shared';

@ApiTags('Contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private contacts: ContactsService) {}

  // ------------------------------------------------------------
  // Contacts list / CRUD
  // ------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'Список моих контактов' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.contacts.listContacts(user.sub);
    return { success: true, data };
  }

  @Get('invitations/incoming')
  @ApiOperation({ summary: 'Входящие приглашения' })
  async listIncoming(@CurrentUser() user: JwtPayload) {
    const data = await this.contacts.listIncomingInvitations(user.sub);
    return { success: true, data };
  }

  @Get('invitations/outgoing')
  @ApiOperation({ summary: 'Исходящие приглашения' })
  async listOutgoing(@CurrentUser() user: JwtPayload) {
    const data = await this.contacts.listOutgoingInvitations(user.sub);
    return { success: true, data };
  }

  @Post('invitations')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Отправить приглашение в контакты' })
  async sendInvitation(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = sendInvitationSchema.parse(body);
    const invitation = await this.contacts.sendInvitation(user.sub, data);
    return { success: true, data: invitation };
  }

  @Post('invitations/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Принять приглашение' })
  async acceptInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = acceptInvitationSchema.parse(body ?? {});
    const link = await this.contacts.acceptInvitation(user.sub, id, data);
    return { success: true, data: link };
  }

  @Post('invitations/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отклонить приглашение' })
  async rejectInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.contacts.rejectInvitation(user.sub, id);
    return { success: true };
  }

  @Post('invitations/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить отправленное приглашение' })
  async cancelInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.contacts.cancelInvitation(user.sub, id);
    return { success: true };
  }

  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Повторно отправить приглашение (cooldown 24ч)' })
  async resendInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const invitation = await this.contacts.resendInvitation(user.sub, id);
    return { success: true, data: invitation };
  }

  // ------------------------------------------------------------
  // Blocks
  // ------------------------------------------------------------

  @Get('blocks')
  @ApiOperation({ summary: 'Список заблокированных' })
  async listBlocks(@CurrentUser() user: JwtPayload) {
    const data = await this.contacts.listBlocks(user.sub);
    return { success: true, data };
  }

  @Post('blocks')
  @ApiOperation({ summary: 'Заблокировать пользователя' })
  async blockUser(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = blockUserSchema.parse(body);
    const block = await this.contacts.blockUser(user.sub, data.userId);
    return { success: true, data: block };
  }

  @Delete('blocks/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Разблокировать пользователя' })
  async unblockUser(
    @CurrentUser() user: JwtPayload,
    @Param('userId') targetUserId: string,
  ) {
    await this.contacts.unblockUser(user.sub, targetUserId);
    return { success: true };
  }

  // ------------------------------------------------------------
  // Single contact — must come last so /invitations/* is not swallowed
  // ------------------------------------------------------------

  @Get(':linkId')
  @ApiOperation({ summary: 'Карточка контакта' })
  async getContact(
    @CurrentUser() user: JwtPayload,
    @Param('linkId') linkId: string,
  ) {
    const data = await this.contacts.getContact(user.sub, linkId);
    return { success: true, data };
  }

  @Patch(':linkId')
  @ApiOperation({ summary: 'Обновить свою метку / relationshipType' })
  async updateContact(
    @CurrentUser() user: JwtPayload,
    @Param('linkId') linkId: string,
    @Body() body: unknown,
  ) {
    const data = updateContactSchema.parse(body);
    const contact = await this.contacts.updateContact(user.sub, linkId, data);
    return { success: true, data: contact };
  }

  @Delete(':linkId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить контакт (двустороннее удаление)' })
  async deleteContact(
    @CurrentUser() user: JwtPayload,
    @Param('linkId') linkId: string,
  ) {
    await this.contacts.deleteContact(user.sub, linkId);
    return { success: true };
  }
}
