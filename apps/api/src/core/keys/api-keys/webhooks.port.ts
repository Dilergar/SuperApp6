import { Injectable } from '@nestjs/common';
import type { KeyRegistryRowDto } from '@superapp/shared';

/**
 * Порт реестра для вебхуков: `core/webhooks` регистрирует поставщика строк реестра
 * (endpoint'ы организации как строки вида `webhook`). Пока никто не зарегистрирован —
 * пусто. Направление «движок вебхуков → движок ключей», без импорта модуля вебхуков.
 */
export interface WebhookRegistryProvider {
  registryRows(workspaceId: string): Promise<KeyRegistryRowDto[]>;
  /** Живых endpoint'ов организации (провайдер расхода `webhooks.maxEndpoints`) */
  countLive(workspaceId: string): Promise<number>;
}

@Injectable()
export class WebhooksRegistryPort {
  private provider: WebhookRegistryProvider | null = null;

  register(provider: WebhookRegistryProvider): void {
    this.provider = provider;
  }

  registryRows(workspaceId: string): Promise<KeyRegistryRowDto[]> {
    return this.provider ? this.provider.registryRows(workspaceId) : Promise.resolve([]);
  }

  countLive(workspaceId: string): Promise<number> {
    return this.provider ? this.provider.countLive(workspaceId) : Promise.resolve(0);
  }
}
