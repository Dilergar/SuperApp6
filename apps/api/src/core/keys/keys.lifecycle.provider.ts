import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleCanaryRegistry, LifecycleSubjectHookRegistry, LifecycleTenantHookRegistry, type LifecycleCanaryPlant } from '../lifecycle/lifecycle.purge.registry';
import { KeysCascadesService } from './api-keys/keys.cascades.service';

/**
 * Хук каскада организации `keys.workspace` (политики `Bot`, `ApiKey`): ключи API и боты
 * организации гаснут, KEK организации уходит на уничтожение (crypto-shredding); эпоха
 * keystore бампается ПОСЛЕ коммита — ключ перестаёт работать на всех инстансах сразу.
 *
 * Стирание человека (`keys.subject`, политика `ApiKey`): его личные токены (PAT) уже отозваны
 * корневым шагом (`onAccountAnonymize`, KEK человека на уничтожение) — строки стираются. Боты,
 * которых он создал, — ключи ОРГАНИЗАЦИИ: заморожены (`creator_left`) и остаются ей. Журнал
 * использования ключей живёт своим сроком (ссылка на ключ — id без FK).
 */
@Injectable()
export class KeysLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly cascades: KeysCascadesService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('keys.workspace', {
      purge: async (workspaceId) => {
        await this.db.$transaction((tx) => this.cascades.onWorkspacePurge(tx, workspaceId));
        await this.cascades.afterScopeDestroyCommitted();
      },
      estimate: async (workspaceId) =>
        (await this.db.apiKey.count({ where: { OR: [{ workspaceId }, { bot: { workspaceId } }], revokedAt: null } })) +
        (await this.db.bot.count({ where: { workspaceId, status: { not: 'archived' } } })),
    });
    this.subjectHooks.register('keys.subject', {
      erase: async (userId) => {
        // Живой PAT здесь быть не может (отозван корневым шагом) — удаляются только погашенные
        const { count } = await this.db.apiKey.deleteMany({ where: { kind: 'pat', userId, revokedAt: { not: null } } });
        return { rows: count };
      },
    });
    // Посев канарейки: живой личный токен (секрета не знает никто — хэш случайный) — корневой
    // шаг его гасит, этот шаг стирает строку
    this.canary.register('keys.subject', async (ctx) => {
      const row = await this.db.apiKey.create({
        data: {
          kind: 'pat',
          userId: ctx.userId,
          familyId: randomUUID(),
          name: ctx.marker,
          purpose: 'canary',
          prefix: 'canary',
          last4: '0000',
          hash: randomBytes(32).toString('hex'),
          hashKid: 'canary',
          createdById: ctx.userId,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        select: { id: true },
      });
      return [{ policy: 'ApiKey', id: row.id, expect: 'gone' }] satisfies LifecycleCanaryPlant[];
    });
  }
}
