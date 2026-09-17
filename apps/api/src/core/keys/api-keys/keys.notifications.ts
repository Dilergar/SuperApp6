import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { KEYS_REDIS, type NotificationType, type WsKeysChanged } from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { RedisService } from '../../../shared/redis/redis.service';
import { AudiencesService } from '../../audiences/audiences.service';
import { NotificationRefRegistry } from '../../notifications/notifications.registry';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { BOT_NOTIFICATION_REF_TYPE, KEYS_NOTIFICATION_REF_TYPE } from '../keys.constants';

type Tx = Prisma.TransactionClient;

/**
 * Уведомления движка ключей: продюсер решает КОМУ. Ключи организации — владелец и
 * админы (роль, через core/audiences); заморозка бота — только владелец; личный ключ
 * для собственных данных — сам человек. Deep link — реестр ключей организации либо
 * «Ключи и приложения» профиля. Сокет `keys:changed` — владельцу и админам (значок
 * «N ботов ждут решения» без перезагрузки).
 */
@Injectable()
export class KeysNotifier implements OnModuleInit {
  private readonly logger = new Logger(KeysNotifier.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly refs: NotificationRefRegistry,
    private readonly audiences: AudiencesService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.refs.register(KEYS_NOTIFICATION_REF_TYPE, {
      canViewMany: async (userIds, refId) => {
        const key = await this.db.apiKey.findUnique({ where: { id: refId }, select: { userId: true, workspaceId: true, botId: true, bot: { select: { workspaceId: true } } } });
        if (!key) return [];
        const ws = key.bot?.workspaceId ?? key.workspaceId;
        const allowed = new Set(ws ? await this.managers(ws) : []);
        if (key.userId) allowed.add(key.userId);
        return userIds.filter((id) => allowed.has(id));
      },
      href: (ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/integrations?key=${ref.id}` : '/profile/keys'),
    });
    this.refs.register(BOT_NOTIFICATION_REF_TYPE, {
      canViewMany: async (userIds, refId) => {
        const bot = await this.db.bot.findUnique({ where: { id: refId }, select: { workspaceId: true } });
        if (!bot) return [];
        const allowed = new Set(await this.managers(bot.workspaceId));
        return userIds.filter((id) => allowed.has(id));
      },
      href: (ref, ctx) => `/workspaces/${ctx.workspaceId ?? ''}/integrations?bot=${ref.id}`,
    });
  }

  /** Владелец и админы организации (роль, не человек). */
  async managers(workspaceId: string, roles: readonly string[] = ['owner', 'admin']): Promise<string[]> {
    try {
      return await this.audiences.resolve([{ type: 'workspace', id: workspaceId }], { workspaceId }, { max: 50, onOverflow: 'truncate', roles: [...roles] });
    } catch (err) {
      this.logger.warn(`managers of ${workspaceId}: ${(err as Error).message}`);
      return [];
    }
  }

  async ownerOf(workspaceId: string): Promise<string | null> {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
    return ws?.ownerId ?? null;
  }

  /** Событие про ключ: организации — владельцу и админам, личный ключ — человеку. */
  async keyEvent(tx: Tx | null, type: NotificationType, key: { id: string; name: string; userId: string | null; workspaceId: string | null }, payload: Record<string, unknown>, opts: { actorId?: string | null; idempotencyKey?: string } = {}): Promise<void> {
    const to = key.workspaceId ? await this.managers(key.workspaceId) : key.userId ? [key.userId] : [];
    if (!to.length) return;
    try {
      await this.notifications.send(tx, {
        type,
        to: to.map((userId) => ({ userId })),
        payload: { keyName: key.name, ...payload },
        ref: { type: KEYS_NOTIFICATION_REF_TYPE, id: key.id },
        workspaceId: key.workspaceId,
        actorId: opts.actorId ?? null,
        includeActor: true,
        reason: key.workspaceId ? 'owner' : 'system',
        idempotencyKey: opts.idempotencyKey,
      });
    } catch (err) {
      this.logger.warn(`notify ${type} for key ${key.id}: ${(err as Error).message}`);
      if (tx) throw err;
    }
  }

  /** Событие про бота: заморозка — только владельцу (решение — его), остальное — владельцу и админам. */
  async botEvent(tx: Tx | null, type: NotificationType, bot: { id: string; name: string; workspaceId: string }, payload: Record<string, unknown>, opts: { actorId?: string | null; ownerOnly?: boolean } = {}): Promise<void> {
    const to = opts.ownerOnly ? [await this.ownerOf(bot.workspaceId)].filter((v): v is string => !!v) : await this.managers(bot.workspaceId);
    if (!to.length) return;
    try {
      await this.notifications.send(tx, {
        type,
        to: to.map((userId) => ({ userId })),
        payload: { botName: bot.name, ...payload },
        ref: { type: BOT_NOTIFICATION_REF_TYPE, id: bot.id },
        workspaceId: bot.workspaceId,
        actorId: opts.actorId ?? null,
        includeActor: true,
        reason: 'owner',
      });
    } catch (err) {
      this.logger.warn(`notify ${type} for bot ${bot.id}: ${(err as Error).message}`);
      if (tx) throw err;
    }
  }

  /** Обращение с чужого адреса при IP-allowlist — не чаще раза в сутки на ключ. */
  async newLocation(keyId: string, workspaceId: string | null, holderUserId: string, kind: 'bot' | 'pat', ip: string | null): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const lock = `keys:newloc:${keyId}:${day}`;
    try {
      const set = await this.redis.getClient().set(lock, '1', 'EX', 86_400, 'NX');
      if (set !== 'OK') return;
    } catch {
      return;
    }
    const key = await this.db.apiKey.findUnique({ where: { id: keyId }, select: { id: true, name: true, userId: true, workspaceId: true } });
    if (!key) return;
    await this.keyEvent(null, 'key.newLocation', { id: key.id, name: key.name, userId: kind === 'bot' ? null : holderUserId, workspaceId: key.workspaceId ?? workspaceId }, { location: ip ?? '' });
  }

  /**
   * Ключ упёрся в потолок: обращений в минуту (`rate`) или строк выгрузки в сутки (`export`).
   * Одно уведомление на ключ в сутки (Redis-замок + idempotencyKey) — аномалия объёма
   * (модель Salesloft), держателю ключа: владельцу и админам либо самому человеку.
   */
  async throttled(keyId: string, kind: 'rate' | 'export'): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const lock = `keys:throttled:${keyId}:${day}`;
    try {
      const set = await this.redis.getClient().set(lock, '1', 'EX', 86_400, 'NX');
      if (set !== 'OK') return;
    } catch {
      return;
    }
    const key = await this.db.apiKey.findUnique({ where: { id: keyId }, select: { id: true, name: true, kind: true, userId: true, workspaceId: true, bot: { select: { workspaceId: true } } } });
    if (!key) return;
    await this.keyEvent(
      null,
      'key.throttled',
      { id: key.id, name: key.name, userId: key.kind === 'bot' ? null : key.userId, workspaceId: key.bot?.workspaceId ?? key.workspaceId },
      { reasonLabelKey: `keys.throttledReason.${kind}` },
      { idempotencyKey: `key.throttled:${key.id}:${day}` },
    );
  }

  /** Сокет владельцу и админам: реестр изменился, значок «ждут решения» пересчитан. */
  async changed(workspaceId: string): Promise<void> {
    try {
      const frozenBots = await this.db.bot.count({ where: { workspaceId, status: 'frozen' } });
      const to = await this.managers(workspaceId);
      const wire: WsKeysChanged = { workspaceId, frozenBots };
      this.realtime.emitToUsers(to, 'keys:changed', wire);
      await this.redis.getClient().incr(KEYS_REDIS.epoch).catch(() => undefined);
    } catch (err) {
      this.logger.warn(`keys:changed for ${workspaceId}: ${(err as Error).message}`);
    }
  }
}
