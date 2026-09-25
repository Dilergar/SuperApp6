import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent, SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import {
  openDmSchema,
  sendMessageSchema,
  sendAttachmentsSchema,
  editMessageSchema,
  markReadSchema,
  createGroupSchema,
  addMembersSchema,
  renameChatSchema,
  scheduleMessageSchema,
  updateScheduledMessageSchema,
  PRESENCE,
  lifecycleChatTimerSchema,
  type PresenceQueryResult,
} from '@superapp/shared';
import { MessengerService } from './messenger.service';
import { MentionsService } from './mentions.service';
import { PresenceService } from './presence.service';
import { ScheduledMessageService } from './scheduled-message.service';

const setAdminSchema = z.object({ admin: z.boolean() }).strict();

@ApiTags('Messenger')
@ApiBearerAuth()
@Controller('messenger')
export class MessengerController {
  constructor(
    private messenger: MessengerService,
    private mentions: MentionsService,
    private presence: PresenceService,
    private scheduled: ScheduledMessageService,
  ) {}

  @Get('presence')
  @ApiOperation({ summary: 'Presence (online / last seen / context) for a set of people' })
  async getPresence(
    @CurrentUser() user: JwtPayload,
    @Query('userIds') userIds?: string,
  ) {
    const ids = (userIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, PRESENCE.MAX_BATCH);
    const data: PresenceQueryResult = { items: await this.presence.statusFor(user.sub, ids) };
    return { success: true, data };
  }

  @Get('chats')
  @ApiOperation({ summary: 'My chats (the inbox)' })
  async listChats(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.messenger.listChats(user.sub) };
  }

  @Get('calls/active')
  @ApiOperation({ summary: 'Live calls in my chats (incoming watcher: load / reconnect)' })
  async myActiveCalls(@CurrentUser() user: JwtPayload) {
    return { success: true, data: { items: await this.messenger.listMyActiveCalls(user.sub) } };
  }

  @Post('chats/dm')
  @ApiOperation({ summary: 'Open or create a direct chat' })
  async openDm(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { userId } = openDmSchema.parse(body);
    return { success: true, data: await this.messenger.openDm(user.sub, userId) };
  }

  // Повтор = ВТОРАЯ группа с теми же людьми: участников в неё уже добавили, и они
  // её увидели. Личный чат (`chats/dm`) ключа не требует — он «найти или создать».
  @Idempotent({ required: true })
  @Post('chats/group')
  @ApiOperation({ summary: 'Create a group chat' })
  async createGroup(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { name, memberIds } = createGroupSchema.parse(body);
    return { success: true, data: await this.messenger.createGroup(user.sub, name, memberIds) };
  }

  @Get('chats/:id')
  @ApiOperation({ summary: 'Chat details and participants' })
  async getChat(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.messenger.getChatDetail(user.sub, id) };
  }

  @Patch('chats/:id')
  @ApiOperation({ summary: 'Rename a group' })
  async rename(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { title } = renameChatSchema.parse(body);
    return { success: true, data: await this.messenger.renameGroup(user.sub, id, title) };
  }

  @Delete('chats/:id')
  @ApiOperation({ summary: 'Delete a group (owner only)' })
  async deleteGroup(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.messenger.deleteGroup(user.sub, id);
    return { success: true };
  }

  @Post('chats/:id/members')
  @ApiOperation({ summary: 'Add participants to a group' })
  async addMembers(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { userIds } = addMembersSchema.parse(body);
    return { success: true, data: await this.messenger.addMembers(user.sub, id, userIds) };
  }

  @Delete('chats/:id/members/:userId')
  @ApiOperation({ summary: 'Remove a participant (yourself — leave)' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetId: string,
  ) {
    if (targetId === user.sub) {
      await this.messenger.leaveGroup(user.sub, id);
      return { success: true };
    }
    return { success: true, data: await this.messenger.removeMember(user.sub, id, targetId) };
  }

  @Post('chats/:id/leave')
  @ApiOperation({ summary: 'Leave a group' })
  async leave(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.messenger.leaveGroup(user.sub, id);
    return { success: true };
  }

  @Post('chats/:id/admins/:userId')
  @ApiOperation({ summary: 'Grant or revoke an administrator (owner only)' })
  async setAdmin(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { admin } = setAdminSchema.parse(body);
    return { success: true, data: await this.messenger.setAdmin(user.sub, id, targetId, admin) };
  }

  @Put('chats/:id/timer')
  @ApiOperation({ summary: 'Auto-delete timer of a chat: 1 / 7 / 30 days or null (off); in an organization chat — not longer than its message retention' })
  async setTimer(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const { days } = lifecycleChatTimerSchema.parse(body ?? {});
    return { success: true, data: await this.messenger.setTimer(user.sub, id, days) };
  }

  @Get('chats/:id/messages')
  @ApiOperation({ summary: 'Chat messages (paginated by seq)' })
  async getMessages(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('before') before?: string,
  ) {
    const beforeSeq = before ? parseInt(before, 10) : undefined;
    return { success: true, data: await this.messenger.getMessages(user.sub, id, beforeSeq) };
  }

  @Get('chats/:id/mentionable')
  @ApiOperation({ summary: 'Who can be mentioned in this chat (for the @-picker)' })
  async mentionable(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('q') q?: string,
  ) {
    return { success: true, data: await this.mentions.mentionableMembers(user.sub, id, q) };
  }

  @Post('chats/:id/messages')
  // Первая волна: у отправки нет «отменить» — дубль виден всем участникам чата
  // навсегда. Ключ обязателен, клиент берёт его из `tempId` пузыря.
  @Idempotent({ required: true })
  @ApiOperation({ summary: 'Send a message' })
  async send(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content, replyToId } = sendMessageSchema.parse(body);
    return { success: true, data: await this.messenger.sendMessage(user.sub, id, content, replyToId) };
  }

  @Post('chats/:id/messages/attachments')
  // Альбом приходит СПИСКОМ ID уже загруженных файлов (это JSON, не multipart),
  // поэтому ключ здесь работает так же, как у обычного сообщения
  @Idempotent({ required: true })
  @ApiOperation({ summary: 'Send attachments (an album of up to 10 engine files + a caption)' })
  async sendAttachments(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { fileIds, caption, replyToId } = sendAttachmentsSchema.parse(body);
    return {
      success: true,
      data: await this.messenger.sendAttachmentMessage(user.sub, id, fileIds, caption, replyToId),
    };
  }

  // ---- Scheduled messages ("Напомнить", Phase 7) ----
  @Get('chats/:id/scheduled')
  @ApiOperation({ summary: 'My scheduled messages in the chat' })
  async listScheduled(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.scheduled.listForChat(user.sub, id) };
  }

  @Post('chats/:id/scheduled')
  // Отложенное — то же сообщение, только позже: дубль так же неотменяем
  @Idempotent({ required: true })
  @ApiOperation({ summary: 'Schedule a message' })
  async schedule(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content, sendAt, replyToId } = scheduleMessageSchema.parse(body);
    return { success: true, data: await this.scheduled.schedule(user.sub, id, content, sendAt, replyToId) };
  }

  @Patch('scheduled/:schedId')
  @ApiOperation({ summary: 'Update a scheduled message' })
  async updateScheduled(
    @CurrentUser() user: JwtPayload,
    @Param('schedId') schedId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const patch = updateScheduledMessageSchema.parse(body);
    return { success: true, data: await this.scheduled.update(user.sub, schedId, patch) };
  }

  @Delete('scheduled/:schedId')
  @ApiOperation({ summary: 'Cancel a scheduled message' })
  async cancelScheduled(@CurrentUser() user: JwtPayload, @Param('schedId') schedId: string) {
    await this.scheduled.cancel(user.sub, schedId);
    return { success: true };
  }

  @Post('chats/:id/read')
  // «Прочитано до seq» — операция «стало так»: летит на каждую прокрутку ленты,
  // и строка в `idem.keys` на каждый такой запрос была бы чистым расходом
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Mark read up to a seq' })
  async read(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { seq } = markReadSchema.parse(body);
    await this.messenger.markRead(user.sub, id, seq);
    return { success: true };
  }

  @Get('tasks/:taskId/chat')
  @ApiOperation({ summary: 'The task chat (context chat)' })
  async getTaskChat(@CurrentUser() user: JwtPayload, @Param('taskId') taskId: string) {
    return { success: true, data: await this.messenger.getTaskChat(user.sub, taskId) };
  }

  @Get('orders/:orderId/chat')
  @ApiOperation({ summary: 'The order chat (context chat)' })
  async getOrderChat(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
    return { success: true, data: await this.messenger.getOrderChat(user.sub, orderId) };
  }

  @Get('events/:eventId/chat')
  @ApiOperation({ summary: 'The event chat (context chat)' })
  async getEventChat(@CurrentUser() user: JwtPayload, @Param('eventId') eventId: string) {
    return { success: true, data: await this.messenger.getEventChat(user.sub, eventId) };
  }

  @Get('office-rooms/:roomId/chat')
  @ApiOperation({ summary: 'The Virtual Office meeting chat (context chat)' })
  async getOfficeRoomChat(@CurrentUser() user: JwtPayload, @Param('roomId') roomId: string) {
    return { success: true, data: await this.messenger.getOfficeRoomChat(user.sub, roomId) };
  }

  @Patch('messages/:id')
  @ApiOperation({ summary: 'Edit my message' })
  async edit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content } = editMessageSchema.parse(body);
    return { success: true, data: await this.messenger.editMessage(user.sub, id, content) };
  }

  @Delete('messages/:id')
  @ApiOperation({ summary: 'Delete my message' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.messenger.deleteMessage(user.sub, id);
    return { success: true };
  }
}
