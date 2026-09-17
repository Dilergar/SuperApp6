import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../../shared/database/database.service';
import { UsageProviderRegistry } from '../../entitlements/entitlements.registry';
import { WebhooksRegistryPort } from './webhooks.port';

/** Провайдеры расхода ключей тарифа: боты организации, личные ключи человека, endpoint'ы вебхуков. */
@Injectable()
export class KeysEntitlementsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly usage: UsageProviderRegistry,
    private readonly webhooks: WebhooksRegistryPort,
  ) {}

  onModuleInit(): void {
    this.usage.register('keys.maxBots', {
      count: (subject, tx) => (tx ?? this.db).bot.count({ where: { workspaceId: subject.id, status: { not: 'archived' } } }),
    });
    this.usage.register('keys.maxPersonalTokens', {
      count: async (subject, tx) => {
        const rows = await (tx ?? this.db).apiKey.findMany({ where: { kind: 'pat', userId: subject.id, revokedAt: null }, select: { expiresAt: true, graceUntil: true } });
        const now = Date.now();
        return rows.filter((r) => (!r.expiresAt || r.expiresAt.getTime() > now) && (!r.graceUntil || r.graceUntil.getTime() > now)).length;
      },
    });
    this.usage.register('webhooks.maxEndpoints', { count: (subject) => this.webhooks.countLive(subject.id) });
  }
}
