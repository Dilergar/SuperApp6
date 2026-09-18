import { Injectable, OnModuleInit } from '@nestjs/common';
import { webhooksEndpointPlatformInputSchema, type WebhooksEndpointPlatformInput } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { conflict, notFound } from '../../shared/errors/api-error';
import { KeysNotifier } from '../keys/api-keys/keys.notifications';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { publicUrlLabel, WebhooksService } from './webhooks.service';

/**
 * Кабинет платформы для вебхуков: панель «Вебхуки» в карточке организации (сводка без
 * секретов; адрес — без query, токены получателя живут там) и рычаг злоупотреблений —
 * отключить endpoint от имени платформы / включить отключённый платформой. Исходящий
 * вебхук — это запросы с наших адресов на чужой: у поддержки и безопасности обязан быть
 * стоп-кран, который организация не снимет сама (`409 keys.webhook.platformDisabled`).
 * Свои контроллеры под `/platform` движок не заводит — только реестры кабинета.
 */
@Injectable()
export class WebhooksPlatformProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly webhooks: WebhooksService,
    private readonly notifier: KeysNotifier,
  ) {}

  onModuleInit(): void {
    this.panels.register({
      key: 'workspace.webhooks',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceWebhooks',
      capability: 'keys.read',
      order: 61,
      eager: false,
      load: async (_actor, id) => {
        const rows = await this.db.webhookEndpoint.findMany({ where: { workspaceId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
        return {
          endpoints: rows.map((e) => ({
            id: e.id,
            url: publicUrlLabel(e.url),
            signing: e.signing,
            status: e.status,
            disabledReason: e.disabledReason,
            eventCount: Array.isArray(e.events) ? e.events.length : 0,
            failures: e.failures,
            failingSince: e.failingSince?.toISOString() ?? null,
            lastDeliveryAt: e.lastDeliveryAt?.toISOString() ?? null,
            createdAt: e.createdAt.toISOString(),
          })),
        };
      },
    });

    this.commands.register<WebhooksEndpointPlatformInput>({
      key: 'webhooks.endpoint.disable',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.webhooksEndpointDisable.title',
      descriptionKey: 'platform.commands.webhooksEndpointDisable.description',
      input: webhooksEndpointPlatformInputSchema,
      capability: 'keys.write',
      risk: 'high',
      target: (i) => ({ type: 'webhook_endpoint', id: i.endpointId }),
      execute: async (ctx, input, tx) => {
        const row = await tx.webhookEndpoint.findUnique({ where: { id: input.endpointId } });
        if (!row) throw notFound('keys.webhook.notFound');
        // Уже отключённый организацией тоже переводим под замок платформы: иначе админ
        // включит его обратно одной кнопкой, и рычаг окажется пустым
        if (row.status === 'disabled' && row.disabledReason === 'platform') throw conflict('keys.webhook.disabled');
        const after = await this.webhooks.platformDisableTx(tx, row, { actorId: ctx.actor.userId, actorKind: 'platform' });
        return {
          before: { status: row.status, disabledReason: row.disabledReason },
          after: { status: after.status, disabledReason: after.disabledReason },
          result: { endpointId: row.id, workspaceId: row.workspaceId },
          afterCommit: () => this.notifier.changed(row.workspaceId),
        };
      },
    });

    this.commands.register<WebhooksEndpointPlatformInput>({
      key: 'webhooks.endpoint.enable',
      version: 1,
      group: 'keys',
      titleKey: 'platform.commands.webhooksEndpointEnable.title',
      descriptionKey: 'platform.commands.webhooksEndpointEnable.description',
      input: webhooksEndpointPlatformInputSchema,
      capability: 'keys.write',
      risk: 'high',
      target: (i) => ({ type: 'webhook_endpoint', id: i.endpointId }),
      execute: async (ctx, input, tx) => {
        const row = await tx.webhookEndpoint.findUnique({ where: { id: input.endpointId } });
        if (!row) throw notFound('keys.webhook.notFound');
        // Кабинет снимает только СВОЙ замок: отключённое организацией или автоматикой включает организация
        if (row.status !== 'disabled' || row.disabledReason !== 'platform') throw conflict('keys.webhook.notPlatformDisabled');
        const after = await this.webhooks.enableTx(tx, row, { actorId: ctx.actor.userId, actorKind: 'platform' });
        return {
          before: { status: row.status, disabledReason: row.disabledReason },
          after: { status: after.status, disabledReason: after.disabledReason },
          result: { endpointId: row.id, workspaceId: row.workspaceId },
          afterCommit: () => this.notifier.changed(row.workspaceId),
        };
      },
    });
  }
}
