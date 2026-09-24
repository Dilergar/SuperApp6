import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  copyNotificationPreferencesSchema,
  devDeliveriesQuerySchema,
  devSendNotificationSchema,
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  notificationIdsSchema,
  notificationMuteSchema,
  pauseNotificationsSchema,
  preferencesContextQuerySchema,
  putNotificationPreferencesSchema,
  putNotificationQuietSchema,
  registerNotificationDeviceSchema,
  removeNotificationDeviceSchema,
  snoozeNotificationSchema,
  NOTIFICATION_PERSONAL_CONTEXT,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { isDevEnv } from '../../shared/config/env.validation';
import { notFound } from '../../shared/errors/api-error';
import { NotificationsService } from './notifications.service';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { NotificationsPreferencesService } from './notifications.preferences.service';
import { NotificationsSettingsService } from './notifications.settings.service';
import { NotificationsCron } from './notifications.cron';
import type { NotificationReason, NotificationType } from '@superapp/shared';

/**
 * `/api/v1/notifications` — центр уведомлений. Статические пути объявлены ДО `:id`
 * (иначе Nest ищет уведомление «counts»/«preferences»). Все флаги query — queryBoolean.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: NotificationsPreferencesService,
    private readonly settings: NotificationsSettingsService,
    private readonly cron: NotificationsCron,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Notification feed (cross-context; filters: context, service, state, mentions)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: unknown) {
    const q = listNotificationsQuerySchema.parse(query ?? {});
    return { success: true, data: await this.notifications.list(user.sub, q) };
  }

  @Get('counts')
  @ApiOperation({ summary: 'Unseen badge + per-context dots' })
  async counts(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.notifications.counts(user.sub) };
  }

  @Get('dev/deliveries')
  @ApiOperation({ summary: '[dev] Delivery ledger: why it did (not) arrive' })
  async devDeliveries(@Query() query: unknown) {
    if (!isDevEnv()) throw notFound('notification.notFound');
    const q = devDeliveriesQuerySchema.parse(query ?? {});
    return { success: true, data: await this.notifications.devDeliveries(q) };
  }

  @Post('dev/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Sandbox: send an event to arbitrary recipients' })
  async devSend(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    if (!isDevEnv()) throw notFound('notification.notFound');
    const input = devSendNotificationSchema.parse(body);
    const res = await this.notifications.send(null, {
      type: input.type as NotificationType,
      to: input.to.map((userId) => ({ userId })),
      payload: input.payload,
      ref: input.ref ?? null,
      actorId: input.actorId ?? user.sub,
      workspaceId: input.workspaceId ?? null,
      reason: input.reason as NotificationReason | undefined,
      collapseKey: input.collapseKey,
      idempotencyKey: input.idempotencyKey,
      actionUrl: input.actionUrl,
      includeActor: input.includeActor,
      budget: input.budget,
    });
    return { success: true, data: res };
  }

  @Post('dev/retention')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run retention now' })
  async devRetention() {
    if (!isDevEnv()) throw notFound('notification.notFound');
    const rows = await this.cron.pruneRows();
    const events = await this.cron.pruneEvents();
    return { success: true, data: { rows, events } };
  }

  // Операция «стало так», а не «сделай ещё раз»: повтор ничего не добавляет.
  // Без исключения каждый показ ленты писал бы строку в `idem.keys` на пустом месте.
  @SkipIdempotency('naturally_idempotent')
  @Post('seen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Shown rows are seen (badge clears); empty = all' })
  async seen(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { ids } = notificationIdsSchema.parse(body ?? {});
    return { success: true, data: await this.notifications.markSeen(user.sub, ids) };
  }

  // Операция «стало так», а не «сделай ещё раз»: повтор ничего не добавляет.
  // Без исключения каждый показ ленты писал бы строку в `idem.keys` на пустом месте.
  @SkipIdempotency('naturally_idempotent')
  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark read: ids or all (within a context)' })
  async read(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = markNotificationsReadSchema.parse(body ?? {});
    return { success: true, data: await this.notifications.markRead(user.sub, input) };
  }

  // ---- mute объекта ----

  // Операция «стало так», а не «сделай ещё раз»: повтор ничего не добавляет.
  // Без исключения каждый показ ленты писал бы строку в `idem.keys` на пустом месте.
  @SkipIdempotency('naturally_idempotent')
  @Post('mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute an object (personal mention and critical break through)' })
  async mute(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { refType, refId } = notificationMuteSchema.parse(body);
    await this.notifications.mute(user.sub, refType, refId);
    return { success: true };
  }

  // Операция «стало так», а не «сделай ещё раз»: повтор ничего не добавляет.
  // Без исключения каждый показ ленты писал бы строку в `idem.keys` на пустом месте.
  @SkipIdempotency('naturally_idempotent')
  @Delete('mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute an object' })
  async unmute(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { refType, refId } = notificationMuteSchema.parse(body);
    await this.notifications.unmute(user.sub, refType, refId);
    return { success: true };
  }

  // ---- настройки: сервис × канал ----

  @Get('preferences')
  @ApiOperation({ summary: 'Preference matrix of a context (personal | organization id)' })
  async getPreferences(@CurrentUser() user: JwtPayload, @Query() query: unknown) {
    const { context } = preferencesContextQuerySchema.parse(query ?? {});
    return { success: true, data: await this.preferences.getPreferences(user.sub, context ?? NOTIFICATION_PERSONAL_CONTEXT) };
  }

  // Операция «стало так», а не «сделай ещё раз»: повтор ничего не добавляет.
  // Без исключения каждый показ ленты писал бы строку в `idem.keys` на пустом месте.
  @SkipIdempotency('naturally_idempotent')
  @Put('preferences')
  @ApiOperation({ summary: 'Sparse overrides (enabled: null clears one)' })
  async putPreferences(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = putNotificationPreferencesSchema.parse(body);
    return { success: true, data: await this.preferences.putPreferences(user.sub, input) };
  }

  @Post('preferences/copy-to-workspaces')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply the set to all my organizations (copy)' })
  async copyPreferences(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = copyNotificationPreferencesSchema.parse(body);
    return { success: true, data: await this.preferences.copyToWorkspaces(user.sub, input) };
  }

  // ---- тишина ----

  @Get('quiet')
  @ApiOperation({ summary: 'Quiet hours: schedule + pause' })
  async getQuiet(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.settings.getQuiet(user.sub) };
  }

  // Операция «стало так», а не «сделай ещё раз»: повтор ничего не добавляет.
  // Без исключения каждый показ ленты писал бы строку в `idem.keys` на пустом месте.
  @SkipIdempotency('naturally_idempotent')
  @Put('quiet')
  @ApiOperation({ summary: 'Quiet schedule (in the user timezone)' })
  async putQuiet(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = putNotificationQuietSchema.parse(body);
    return { success: true, data: await this.settings.putQuiet(user.sub, input) };
  }

  @Post('quiet/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One-off pause: minutes | untilMorning | clear' })
  async pause(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = pauseNotificationsSchema.parse(body);
    return { success: true, data: await this.settings.pause(user.sub, input) };
  }

  // ---- устройства push ----

  @Get('vapid-public-key')
  @ApiOperation({ summary: 'Public VAPID key (null: web push not configured)' })
  vapid() {
    return { success: true, data: this.settings.vapid() };
  }

  @Get('devices')
  @ApiOperation({ summary: 'My push devices' })
  async devices(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.settings.listDevices(user.sub) };
  }

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register/refresh a device (web push endpoint checked against the host whitelist)' })
  async registerDevice(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Headers('user-agent') ua?: string) {
    const input = registerNotificationDeviceSchema.parse(body);
    return { success: true, data: await this.settings.registerDevice(user.sub, input, ua) };
  }

  @Delete('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a device (id or provider+token)' })
  async removeDevice(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = removeNotificationDeviceSchema.parse(body);
    await this.settings.removeDevice(user.sub, input);
    return { success: true };
  }

  // ---- состояния строки (после статики) ----

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async readOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'read') };
  }

  @Post(':id/unread')
  @HttpCode(HttpStatus.OK)
  async unreadOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'unread') };
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Done: hide from the main view' })
  async archive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'archive') };
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  async unarchive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'unarchive') };
  }

  @Post(':id/save')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save (exempt from retention)' })
  async save(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'save') };
  }

  @Post(':id/unsave')
  @HttpCode(HttpStatus.OK)
  async unsave(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'unsave') };
  }

  @Post(':id/snooze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Snooze until a time (auto-wake; new activity wakes earlier)' })
  async snooze(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const { until } = snoozeNotificationSchema.parse(body);
    return { success: true, data: await this.notifications.snooze(user.sub, id, new Date(until)) };
  }

  @Post(':id/unsnooze')
  @HttpCode(HttpStatus.OK)
  async unsnooze(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.notifications.setState(user.sub, id, 'unsnooze') };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a row (no UI; API/AI only)' })
  async delete(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.notifications.delete(user.sub, id);
    return { success: true };
  }
}
