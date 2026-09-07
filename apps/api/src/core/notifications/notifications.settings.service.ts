import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NOTIFICATION_LIMITS,
  isAllowedWebPushEndpoint,
  type NotificationDeviceDto,
  type NotificationDevicePlatform,
  type NotificationDeviceProvider,
  type NotificationDeviceRegisteredDto,
  type NotificationQuietDto,
  type NotificationVapidDto,
  type PauseNotificationsInput,
  type PutNotificationQuietInput,
  type RegisterNotificationDeviceInput,
  type RemoveNotificationDeviceInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { nextMorning, quietState } from './notifications.quiet';
import { NotificationChannelRegistry } from './notifications.registry';

/**
 * Личные сквозные настройки: тишина (расписание в `User.timezone` + разовая пауза) и
 * устройства push. Организация дефолт тишины не задаёт (личное сильнее — Slack).
 */
@Injectable()
export class NotificationsSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: NotificationChannelRegistry,
  ) {}

  // ---------- тишина ----------

  async getQuiet(userId: string): Promise<NotificationQuietDto> {
    const [settings, user] = await Promise.all([
      this.db.userNotificationSettings.findUnique({ where: { userId } }),
      this.db.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    ]);
    const timezone = user?.timezone ?? 'Asia/Almaty';
    const state = quietState(settings, new Date(), timezone);
    return {
      schedule: Array.isArray(settings?.quietSchedule) ? (settings!.quietSchedule as unknown as NotificationQuietDto['schedule']) : null,
      pausedUntil: settings?.pausedUntil && settings.pausedUntil > new Date() ? settings.pausedUntil.toISOString() : null,
      timezone,
      activeNow: state.quiet,
    };
  }

  async putQuiet(userId: string, input: PutNotificationQuietInput): Promise<NotificationQuietDto> {
    const schedule = input.schedule && input.schedule.length ? (input.schedule as unknown as Prisma.InputJsonValue) : null;
    await this.db.userNotificationSettings.upsert({
      where: { userId },
      update: { quietSchedule: schedule === null ? Prisma.DbNull : schedule },
      create: { userId, quietSchedule: schedule === null ? undefined : schedule },
    });
    return this.getQuiet(userId);
  }

  /** Разовая пауза из панели колокольчика: 30 мин / 1 ч / 2 ч / до утра; `clear` снимает. */
  async pause(userId: string, input: PauseNotificationsInput): Promise<NotificationQuietDto> {
    let pausedUntil: Date | null = null;
    if (!input.clear) {
      if (input.untilMorning) {
        const user = await this.db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
        pausedUntil = nextMorning(new Date(), user?.timezone ?? 'Asia/Almaty');
      } else if (input.minutes) {
        pausedUntil = new Date(Date.now() + input.minutes * 60_000);
      }
    }
    await this.db.userNotificationSettings.upsert({
      where: { userId },
      update: { pausedUntil },
      create: { userId, pausedUntil },
    });
    return this.getQuiet(userId);
  }

  // ---------- устройства ----------

  vapid(): NotificationVapidDto {
    return { publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY || null };
  }

  async listDevices(userId: string): Promise<NotificationDeviceDto[]> {
    const rows = await this.db.notificationDevice.findMany({ where: { userId }, orderBy: { lastSeenAt: 'desc' } });
    return rows.map((d) => this.toDeviceDto(d));
  }

  /**
   * Регистрация/обновление устройства. Endpoint web-push — адрес ИЗ ДАННЫХ: перед тем как
   * движок начнёт на него ходить, он обязан пройти белый список хостов push-служб
   * (правило двух дверей docs/security.md).
   */
  async registerDevice(userId: string, input: RegisterNotificationDeviceInput, userAgentHeader?: string): Promise<NotificationDeviceRegisteredDto> {
    if (input.provider === 'webpush') {
      if (!isAllowedWebPushEndpoint(input.token)) throw badRequest('notification.device.invalidEndpoint');
      if (input.subscription && input.subscription.endpoint !== input.token) throw badRequest('notification.device.invalidEndpoint');
      if (!process.env.WEB_PUSH_VAPID_PUBLIC_KEY) throw badRequest('notification.push.notConfigured');
    }
    const userAgent = (input.userAgent ?? userAgentHeader ?? '').slice(0, 300) || null;
    // Токен переехал к другому аккаунту на том же устройстве — строка переезжает вместе с ним
    const row = await this.db.notificationDevice.upsert({
      where: { provider_token: { provider: input.provider, token: input.token } },
      update: {
        userId,
        platform: input.platform,
        subscription: (input.subscription as unknown as Prisma.InputJsonValue) ?? Prisma.DbNull,
        userAgent,
        lastSeenAt: new Date(),
        failureCount: 0,
        disabledAt: null,
      },
      create: {
        userId,
        platform: input.platform,
        provider: input.provider,
        token: input.token,
        subscription: (input.subscription as unknown as Prisma.InputJsonValue) ?? undefined,
        userAgent,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  async removeDevice(userId: string, input: RemoveNotificationDeviceInput): Promise<void> {
    const where: Prisma.NotificationDeviceWhereInput = input.id
      ? { id: input.id, userId }
      : { provider: input.provider!, token: input.token!, userId };
    const res = await this.db.notificationDevice.deleteMany({ where });
    if (res.count === 0) throw notFound('notification.device.notFound');
  }

  /** Крон: устройство без визита дольше окна свежести отключается (токены протухают — FCM). */
  async expireStaleDevices(): Promise<number> {
    const cutoff = new Date(Date.now() - NOTIFICATION_LIMITS.deviceStaleDays * 86_400_000);
    const res = await this.db.notificationDevice.updateMany({
      where: { disabledAt: null, lastSeenAt: { lt: cutoff } },
      data: { disabledAt: new Date() },
    });
    return res.count;
  }

  get pushLive(): boolean {
    return this.channels.pushLive;
  }

  private toDeviceDto(d: {
    id: string;
    platform: string;
    provider: string;
    userAgent: string | null;
    lastSeenAt: Date;
    createdAt: Date;
    disabledAt: Date | null;
  }): NotificationDeviceDto {
    return {
      id: d.id,
      platform: d.platform as NotificationDevicePlatform,
      provider: d.provider as NotificationDeviceProvider,
      userAgent: d.userAgent,
      lastSeenAt: d.lastSeenAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
      disabledAt: d.disabledAt?.toISOString() ?? null,
    };
  }
}
