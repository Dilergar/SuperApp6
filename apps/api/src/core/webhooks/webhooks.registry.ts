import { Injectable } from '@nestjs/common';
import { WEBHOOK_EVENT_REGISTRY, WEBHOOK_SYSTEM_EVENTS, isWebhookEventKey, webhookEventsByService, type WebhookEventCatalogDto, type WebhookEventKey } from '@superapp/shared';
import { badRequest } from '../../shared/errors/api-error';

/**
 * Каталог событий вебхуков — реестр `packages/shared/src/keys/webhook-events.ts`
 * (`defineWebhookEvents` по сервисам: tasks, documents, workspaces). Новый продюсер =
 * +1 файл-регистрация в shared + `webhooks.emit(tx, …)` в транзакции мутации.
 * Служебные события (`webhook.ping`, `webhook.test`) в каталог не входят: их шлёт сам
 * движок, подписаться на них нельзя.
 */
@Injectable()
export class WebhooksRegistry {
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
