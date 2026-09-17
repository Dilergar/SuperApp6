import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  keysBotFreezeInputSchema,
  keysKeyRevokeInputSchema,
  type KeysBotFreezeInput,
  type KeysKeyRevokeInput,
} from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { conflict, notFound } from '../../../shared/errors/api-error';
import { PlatformCommandRegistry } from '../../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../../platform/platform-lookup.registry';
import { keyStatusOf } from './api-keys.common';
import { ApiKeysService } from './api-keys.service';
import { BotsService } from './bots.service';

/**
 * Кабинет платформы для ключей API (фаза E): панели «Ключи» в карточке организации и
 * человека (сводки без секретов и без содержимого), команды отзыва ключа и заморозки /
 * разморозки бота (журнал append-only кабинета + журнал ключей организации, причина
 * обязательна). Свои контроллеры под `/platform` движок не заводит.
 */
@Injectable()
export class KeysPlatformPanel implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly keys: ApiKeysService,
    private readonly bots: BotsService,
  ) {}

  onModuleInit(): void {
    this.panels.register({
      key: 'workspace.keys',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceKeys',
      capability: 'keys.read',
      order: 60,
      eager: false,
      load: async (_actor, id) => {
        const [bots, keys, policy] = await Promise.all([
          this.db.bot.groupBy({ by: ['status'], where: { workspaceId: id }, _count: { _all: true } }),
          this.db.apiKey.findMany({
            where: { OR: [{ workspaceId: id }, { bot: { workspaceId: id } }] },
            select: { id: true, kind: true, name: true, prefix: true, last4: true, revokedAt: true, expiresAt: true, graceUntil: true, lastUsedAt: true, createdAt: true, bot: { select: { id: true, name: true, status: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
          }),
          this.db.workspaceKeyPolicy.findUnique({ where: { workspaceId: id } }),
        ]);
        const now = Date.now();
        return {
          bots: bots.map((b) => ({ status: b.status, count: b._count._all })),
          keys: keys.map((k) => ({
            id: k.id,
            kind: k.kind,
            name: k.name,
            prefix: k.prefix,
            last4: k.last4,
            status: keyStatusOf(k, k.bot?.status ?? null, now),
            bot: k.bot ? { id: k.bot.id, name: k.bot.name, status: k.bot.status } : null,
            expiresAt: k.expiresAt?.toISOString() ?? null,
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
            createdAt: k.createdAt.toISOString(),
          })),
          policy: policy ? { maxPatDays: policy.maxPatDays, maxBotKeyDays: policy.maxBotKeyDays, requireIpAllowlist: policy.requireIpAllowlist } : null,
        };
      },
    });

    this.panels.register({
      key: 'user.keys',
      entity: 'user',
      titleKey: 'platform.panels.userKeys',
      capability: 'keys.read',
      order: 60,
      eager: false,
      load: async (_actor, userId) => {
        const [pats, botsCreated] = await Promise.all([
          this.db.apiKey.findMany({
            where: { kind: 'pat', userId },
            select: { id: true, name: true, prefix: true, last4: true, workspaceId: true, revokedAt: true, expiresAt: true, graceUntil: true, lastUsedAt: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 50,
          }),
          this.db.bot.count({ where: { createdById: userId, status: { not: 'archived' } } }),
        ]);
        const now = Date.now();
        return {
          personalKeys: pats.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, last4: k.last4, workspaceId: k.workspaceId, status: keyStatusOf(k, null, now), expiresAt: k.expiresAt?.toISOString() ?? null, lastUsedAt: k.lastUsedAt?.toISOString() ?? null, createdAt: k.createdAt.toISOString() })),
          botsCreated,
        };
      },
    });

    this.commands.register<KeysKeyRevokeInput>({
      key: 'keys.key.revoke',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysKeyRevoke.title',
      descriptionKey: 'platform.commands.keysKeyRevoke.description',
      input: keysKeyRevokeInputSchema,
      capability: 'keys.write',
      risk: 'high',
      target: (i) => ({ type: 'api_key', id: i.keyId }),
      execute: async (ctx, input, tx) => {
        const row = await tx.apiKey.findUnique({ where: { id: input.keyId } });
        if (!row) throw notFound('keys.keyNotFound');
        if (row.revokedAt) throw conflict('keys.revoked');
        await this.keys.revokeTx(tx, row, { actorId: ctx.actor.userId, actorKind: 'platform' }, 'platform', ctx.reason ?? null);
        return { before: { revokedAt: null }, after: { revokedAt: new Date().toISOString() }, result: { keyId: row.id } };
      },
    });

    this.commands.register<KeysBotFreezeInput>({
      key: 'keys.bot.freeze',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysBotFreeze.title',
      descriptionKey: 'platform.commands.keysBotFreeze.description',
      input: keysBotFreezeInputSchema,
      capability: 'keys.write',
      risk: 'high',
      target: (i) => ({ type: 'bot', id: i.botId }),
      execute: async (ctx, input, tx) => {
        const bot = await tx.bot.findUnique({ where: { id: input.botId } });
        if (!bot) throw notFound('keys.bot.notFound');
        if (bot.status !== 'active') throw conflict('keys.bot.frozen');
        await this.bots.freezeTx(tx, bot, 'platform', { actorId: ctx.actor.userId, actorKind: 'platform' });
        return { before: { status: 'active' }, after: { status: 'frozen' }, result: { botId: bot.id, workspaceId: bot.workspaceId } };
      },
    });

    this.commands.register<KeysBotFreezeInput>({
      key: 'keys.bot.unfreeze',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.keysBotUnfreeze.title',
      descriptionKey: 'platform.commands.keysBotUnfreeze.description',
      input: keysBotFreezeInputSchema,
      capability: 'keys.write',
      risk: 'high',
      target: (i) => ({ type: 'bot', id: i.botId }),
      execute: async (ctx, input, tx) => {
        const bot = await tx.bot.findUnique({ where: { id: input.botId } });
        if (!bot) throw notFound('keys.bot.notFound');
        if (bot.status !== 'frozen') throw conflict('keys.bot.notFrozen');
        await this.bots.unfreezeTx(tx, bot, { actorId: ctx.actor.userId, actorKind: 'platform' }, ctx.reason ?? null);
        return { before: { status: 'frozen' }, after: { status: 'active' }, result: { botId: bot.id, workspaceId: bot.workspaceId } };
      },
    });
  }
}
