import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
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
  @ApiOperation({ summary: 'Присутствие (онлайн/был(а)/контекст) для набора пользователей' })
  async getPresence(
    @CurrentUser() user: JwtPayload,
    @Query('userIds') userIds?: string,
  ) {
    const ids = (userIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, PRESENCE.MAX_BATCH);
    return { success: true, data: { items: await this.presence.statusFor(user.sub, ids) } };
  }

  @Get('chats')
  @ApiOperation({ summary: 'Мои чаты (инбокс)' })
  async listChats(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.messenger.listChats(user.sub) };
  }

  @Get('calls/active')
  @ApiOperation({ summary: 'Живые звонки моих чатов (watcher входящих: загрузка/reconnect)' })
  async myActiveCalls(@CurrentUser() user: JwtPayload) {
    return { success: true, data: { items: await this.messenger.listMyActiveCalls(user.sub) } };
  }

  @Post('chats/dm')
  @ApiOperation({ summary: 'Открыть/создать личный диалог' })
  async openDm(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { userId } = openDmSchema.parse(body);
    return { success: true, data: await this.messenger.openDm(user.sub, userId) };
  }

  @Post('chats/group')
  @ApiOperation({ summary: 'Создать групповой чат' })
  async createGroup(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const { name, memberIds } = createGroupSchema.parse(body);
    return { success: true, data: await this.messenger.createGroup(user.sub, name, memberIds) };
  }

  @Get('chats/:id')
  @ApiOperation({ summary: 'Детали чата + участники' })
  async getChat(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.messenger.getChatDetail(user.sub, id) };
  }

  @Patch('chats/:id')
  @ApiOperation({ summary: 'Переименовать группу' })
  async rename(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { title } = renameChatSchema.parse(body);
    return { success: true, data: await this.messenger.renameGroup(user.sub, id, title) };
  }

  @Delete('chats/:id')
  @ApiOperation({ summary: 'Удалить группу (только владелец)' })
  async deleteGroup(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.messenger.deleteGroup(user.sub, id);
    return { success: true };
  }

  @Post('chats/:id/members')
  @ApiOperation({ summary: 'Добавить участников в группу' })
  async addMembers(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { userIds } = addMembersSchema.parse(body);
    return { success: true, data: await this.messenger.addMembers(user.sub, id, userIds) };
  }

  @Delete('chats/:id/members/:userId')
  @ApiOperation({ summary: 'Убрать участника (себя — выйти)' })
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
  @ApiOperation({ summary: 'Выйти из группы' })
  async leave(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.messenger.leaveGroup(user.sub, id);
    return { success: true };
  }

  @Post('chats/:id/admins/:userId')
  @ApiOperation({ summary: 'Назначить/снять администратора (только владелец)' })
  async setAdmin(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { admin } = setAdminSchema.parse(body);
    return { success: true, data: await this.messenger.setAdmin(user.sub, id, targetId, admin) };
  }

  @Get('chats/:id/messages')
  @ApiOperation({ summary: 'Сообщения чата (пагинация по seq)' })
  async getMessages(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('before') before?: string,
  ) {
    const beforeSeq = before ? parseInt(before, 10) : undefined;
    return { success: true, data: await this.messenger.getMessages(user.sub, id, beforeSeq) };
  }

  @Get('chats/:id/mentionable')
  @ApiOperation({ summary: 'Кого можно упомянуть в этом чате (для @-пикера)' })
  async mentionable(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('q') q?: string,
  ) {
    return { success: true, data: await this.mentions.mentionableMembers(user.sub, id, q) };
  }

  @Post('chats/:id/messages')
  @ApiOperation({ summary: 'Отправить сообщение' })
  async send(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content, replyToId } = sendMessageSchema.parse(body);
    return { success: true, data: await this.messenger.sendMessage(user.sub, id, content, replyToId) };
  }

  @Post('chats/:id/messages/attachments')
  @ApiOperation({ summary: 'Отправить вложения (альбом до 10 файлов движка + подпись)' })
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
  @ApiOperation({ summary: 'Мои запланированные сообщения в чате' })
  async listScheduled(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.scheduled.listForChat(user.sub, id) };
  }

  @Post('chats/:id/scheduled')
  @ApiOperation({ summary: 'Запланировать сообщение (отложенное)' })
  async schedule(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content, sendAt, replyToId } = scheduleMessageSchema.parse(body);
    return { success: true, data: await this.scheduled.schedule(user.sub, id, content, sendAt, replyToId) };
  }

  @Patch('scheduled/:schedId')
  @ApiOperation({ summary: 'Изменить запланированное сообщение' })
  async updateScheduled(
    @CurrentUser() user: JwtPayload,
    @Param('schedId') schedId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const patch = updateScheduledMessageSchema.parse(body);
    return { success: true, data: await this.scheduled.update(user.sub, schedId, patch) };
  }

  @Delete('scheduled/:schedId')
  @ApiOperation({ summary: 'Отменить запланированное сообщение' })
  async cancelScheduled(@CurrentUser() user: JwtPayload, @Param('schedId') schedId: string) {
    await this.scheduled.cancel(user.sub, schedId);
    return { success: true };
  }

  @Post('chats/:id/read')
  @ApiOperation({ summary: 'Отметить прочитанным до seq' })
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
  @ApiOperation({ summary: 'Чат задачи (контекстный)' })
  async getTaskChat(@CurrentUser() user: JwtPayload, @Param('taskId') taskId: string) {
    return { success: true, data: await this.messenger.getTaskChat(user.sub, taskId) };
  }

  @Get('orders/:orderId/chat')
  @ApiOperation({ summary: 'Чат заказа (контекстный)' })
  async getOrderChat(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
    return { success: true, data: await this.messenger.getOrderChat(user.sub, orderId) };
  }

  @Get('events/:eventId/chat')
  @ApiOperation({ summary: 'Чат события (контекстный)' })
  async getEventChat(@CurrentUser() user: JwtPayload, @Param('eventId') eventId: string) {
    return { success: true, data: await this.messenger.getEventChat(user.sub, eventId) };
  }

  @Get('office-rooms/:roomId/chat')
  @ApiOperation({ summary: 'Чат встречи Виртуального офиса (контекстный)' })
  async getOfficeRoomChat(@CurrentUser() user: JwtPayload, @Param('roomId') roomId: string) {
    return { success: true, data: await this.messenger.getOfficeRoomChat(user.sub, roomId) };
  }

  @Patch('messages/:id')
  @ApiOperation({ summary: 'Редактировать своё сообщение' })
  async edit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { content } = editMessageSchema.parse(body);
    return { success: true, data: await this.messenger.editMessage(user.sub, id, content) };
  }

  @Delete('messages/:id')
  @ApiOperation({ summary: 'Удалить своё сообщение' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.messenger.deleteMessage(user.sub, id);
    return { success: true };
  }
}
