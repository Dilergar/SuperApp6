import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor, lifecyclePolicy } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry, type LifecyclePurgeBatchContext } from '../../core/lifecycle/lifecycle.purge.registry';
import { LifecycleSettings } from '../../core/lifecycle/lifecycle.settings';
import { holdFreeSql, lifecycleTableOf, lockHoldsShared } from '../../core/lifecycle/lifecycle.sql';
import { MessengerService } from './messenger.service';

const RETENTION_CURSOR = { w: 'uuid', c: 'uuid?' } as const;

/**
 * Мессенджер в движке сроков core/lifecycle:
 *  - `messenger.retention` (политика `Message`) — срок переписки организации выбирает
 *    организация (коридор, класс `user_content_shared`): сообщения её чатов старше срока
 *    уходят пачками по (чат, seq), удерживаемые заморозкой остаются; поиск и вложения
 *    добирает loose FK. Умолчание — вечно (без настройки шаг ничего не делает);
 *  - `messenger.workspace-chats` (политика `Chat`) — каскад организации: её чаты.
 */
@Injectable()
export class MessengerLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly settings: LifecycleSettings,
    private readonly messenger: MessengerService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('messenger.retention', {
      purgeBatch: (ctx) => this.retentionBatch(ctx),
    });
    this.tenantHooks.register('messenger.workspace-chats', {
      purge: (workspaceId, ctx) =>
        this.messenger.purgeWorkspaceChats(workspaceId, {
          deadline: ctx.deadline,
          checkpoint: () => ctx.checkpoint(),
          releasable: (tx, ids) => ctx.releasable(tx, 'Chat', ids),
        }),
      estimate: (workspaceId) => this.db.message.count({ where: { chat: { workspaceId } } }),
    });
  }

  /** Одна пачка: первая организация (от курсора) с конечным сроком и сообщениями старше него. */
  private async retentionBatch({ policy, limit, cursor }: LifecyclePurgeBatchContext) {
    const tenants = await this.settings.tenantRetentions(policy);
    if (!tenants.length) return { rows: 0, more: false, cursor: null };
    const table = lifecycleTableOf(policy);
    const chatPolicy = lifecyclePolicy('Chat');
    if (!table || !chatPolicy) return { rows: 0, more: false, cursor: null };
    const c = decodeCursor(cursor, RETENTION_CURSOR);
    for (const t of tenants) {
      if (c && t.workspaceId < c.w) continue;
      const cutoff = new Date(Date.now() - t.days * 86_400_000);
      let afterChat = c && t.workspaceId === c.w ? c.c : null;
      for (;;) {
        const chats = await this.db.chat.findMany({
          where: { workspaceId: t.workspaceId, ...(afterChat ? { id: { gt: afterChat } } : {}) },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 100,
        });
        if (!chats.length) break;
        for (const chat of chats) {
          const n = await this.db.$transaction(async (tx) => {
            await lockHoldsShared(tx);
            await tx.$executeRaw`SELECT set_config('lock_timeout', '1000ms', true)`;
            return tx.$executeRaw(Prisma.sql`
              DELETE FROM "messages" t
               USING (
                 SELECT t.id FROM "messages" t
                  WHERE t.chat_id = ${chat.id}::uuid AND t.created_at < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
                    AND ${holdFreeSql(policy, table)}
                  ORDER BY t.seq
                  LIMIT ${limit}
                  FOR UPDATE OF t SKIP LOCKED
               ) d
              WHERE t.id = d.id`);
          });
          if (n > 0) return { rows: n, more: true, cursor: encodeCursor({ w: t.workspaceId, c: n >= limit ? afterChat : chat.id }) };
          afterChat = chat.id;
        }
      }
    }
    return { rows: 0, more: false, cursor: null };
  }
}
