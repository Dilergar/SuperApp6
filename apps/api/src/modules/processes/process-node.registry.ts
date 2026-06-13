import { Injectable, Logger } from '@nestjs/common';
import type { ProcessNodeTypeDto } from '@superapp/shared';
import type { ProcessNodeProvider } from './process-node.types';

/**
 * Реестр типов нод — 5-й платформенный реестр (после access/rich-cards/search/quick-actions).
 * Встроенные ноды регистрирует ProcessesService на init; будущие сервисы (CRM, Магазин…)
 * добавляют свои ноды одной регистрацией — канвас и валидация «загораются» сами.
 */
@Injectable()
export class ProcessNodeRegistry {
  private readonly logger = new Logger(ProcessNodeRegistry.name);
  private readonly providers = new Map<string, ProcessNodeProvider>();

  register(provider: ProcessNodeProvider): void {
    const type = provider.descriptor.type;
    if (this.providers.has(type)) {
      this.logger.warn(`process node "${type}" already registered — overwriting`);
    }
    this.providers.set(type, provider);
  }

  get(type: string): ProcessNodeProvider | undefined {
    return this.providers.get(type);
  }

  all(): ProcessNodeProvider[] {
    return [...this.providers.values()];
  }

  /** Сериализованные паспорта для палитры (system-ноды — только платформенной роли). */
  listTypes(includeSystem: boolean): ProcessNodeTypeDto[] {
    return this.all()
      .filter((p) => includeSystem || p.descriptor.tier !== 'system')
      .map((p) => {
        // multiOut/join остаются в DTO (нужны редактору для множественных/входящих связей).
        const { configSchema: _s, auto: _a, ...dto } = p.descriptor;
        return dto;
      });
  }
}
