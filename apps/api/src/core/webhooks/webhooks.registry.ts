import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WEBHOOK_EVENT_REGISTRY, WEBHOOK_SYSTEM_EVENTS, isWebhookEventKey, webhookEventsByService, type WebhookEventCatalogDto, type WebhookEventKey } from '@superapp/shared';
import { badRequest } from '../../shared/errors/api-error';

/**
 * Каталог событий вебхуков — реестр `packages/shared/src/keys/webhook-events.ts`
 * (`defineWebhookEvents` по сервисам: tasks, documents, workspaces). Новый продюсер =
 * +1 файл-регистрация в shared + `webhooks.emit(tx, …)` в транзакции мутации.
 * Служебные события (`webhook.ping`, `webhook.test`) в каталог не входят: их шлёт сам
 * движок, подписаться на них нельзя.
 */
/**
 * Хук смены подписки на группу событий (по префиксу ключа). Владелец событий решает сам:
 * тариф (стрим журнала безопасности — `audit.stream`, 402) и факт в своём журнале. Зовётся
 * ВНУТРИ транзакции создания/правки/удаления endpoint'а — отказ хука откатывает изменение.
 */
export interface WebhookSubscriptionHook {
  prefix: string;
  onChange(tx: Prisma.TransactionClient, ctx: { actorId: string; workspaceId: string; before: string[]; after: string[] }): Promise<void>;
}

@Injectable()
export class WebhooksRegistry {
  private readonly hooks = new Map<string, WebhookSubscriptionHook>();

  /** Движок-владелец группы событий подписывается сам (движок вебхуков о нём не знает). */
  registerSubscriptionHook(hook: WebhookSubscriptionHook): void {
    this.hooks.set(hook.prefix, hook);
  }

  /** Прогнать хуки групп, чей состав подписки изменился (before → after). */
  async runSubscriptionHooks(tx: Prisma.TransactionClient, ctx: { actorId: string; workspaceId: string; before: readonly string[]; after: readonly string[] }): Promise<void> {
    for (const hook of this.hooks.values()) {
      const before = ctx.before.filter((k) => k.startsWith(hook.prefix)).sort();
      const after = ctx.after.filter((k) => k.startsWith(hook.prefix)).sort();
      if (before.join(',') === after.join(',')) continue;
      await hook.onChange(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, before, after });
    }
  }

  catalog(): WebhookEventCatalogDto {
    return {
      services: webhookEventsByService().map((s) => ({
        service: s.service,
        events: s.events.map((key) => ({ key, version: WEBHOOK_EVENT_REGISTRY[key].version })),
      })),
    };
  }

  versionOf(key: string): number {
    if (key === WEBHOOK_SYSTEM_EVENTS.ping || key === WEBHOOK_SYSTEM_EVENTS.test) return 1;
    return isWebhookEventKey(key) ? WEBHOOK_EVENT_REGISTRY[key].version : 1;
  }

  /** Список ключей из формы: только реестр, без дублей (Zod уже проверил enum — здесь защита от гонки реестров). */
  normalize(keys: readonly string[]): WebhookEventKey[] {
    const out: WebhookEventKey[] = [];
    for (const k of keys) {
      if (!isWebhookEventKey(k)) throw badRequest('keys.webhook.unknownEvent', { event: k });
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }
}
