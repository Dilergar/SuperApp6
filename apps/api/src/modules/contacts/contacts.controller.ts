import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
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
  listInvitationsQuerySchema,
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
  @ApiOperation({ summary: 'My contacts' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('cursor') cursor?: string,
  ) {
    // Страница едет в `data` ЦЕЛЬНОЙ (CursorPage<Contact>): контроллер поля не
    // переименовывает и не расплющивает — иначе клиент вынужден собирать её обратно
    // своим типом, которого не проверяет никто (так родились 8 рукописей на вебе).
    return { success: true, data: await this.contacts.listContacts(user.sub, cursor) };
  }

  @Get('invitations/incoming')
  @ApiOperation({ summary: 'Incoming invitations' })
  async listIncoming(
    @CurrentUser() user: JwtPayload,
    @Query('cursor') cursor?: string,
  ) {
    return { success: true, data: await this.contacts.listIncomingInvitations(user.sub, cursor) };
  }

  @Get('invitations/outgoing')
  @ApiOperation({
    summary: 'Outgoing invitations (scope=pending | history)',
  })
  async listOutgoing(@CurrentUser() user: JwtPayload, @Query() query: unknown) {
    const { scope, cursor } = listInvitationsQuerySchema.parse(query ?? {});
    return {
      success: true,
      data: await this.contacts.listOutgoingInvitations(user.sub, { scope, cursor }),
    };
  }

  @Post('invitations')
  @Throttle({ long: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Send a contact invitation' })
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
  @ApiOperation({ summary: 'Accept an invitation' })
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
  @ApiOperation({ summary: 'Decline an invitation' })
  async rejectInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.contacts.rejectInvitation(user.sub, id);
    return { success: true };
  }

  @Post('invitations/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an invitation you sent' })
  async cancelInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.contacts.cancelInvitation(user.sub, id);
    return { success: true };
  }

  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send an invitation again (24h cooldown)' })
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
  @ApiOperation({ summary: 'Blocked people' })
  async listBlocks(@CurrentUser() user: JwtPayload) {
    const data = await this.contacts.listBlocks(user.sub);
    return { success: true, data };
  }

  @Post('blocks')
  @ApiOperation({ summary: 'Block a person' })
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
  @ApiOperation({ summary: 'Unblock a person' })
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
  @ApiOperation({ summary: 'A contact card' })
  async getContact(
    @CurrentUser() user: JwtPayload,
    @Param('linkId') linkId: string,
  ) {
    const data = await this.contacts.getContact(user.sub, linkId);
    return { success: true, data };
  }

  @Patch(':linkId')
  @ApiOperation({ summary: 'Update the contact role (my side)' })
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
  @ApiOperation({ summary: 'Delete a contact (both sides)' })
  async deleteContact(
    @CurrentUser() user: JwtPayload,
    @Param('linkId') linkId: string,
  ) {
    await this.contacts.deleteContact(user.sub, linkId);
    return { success: true };
  }
}
