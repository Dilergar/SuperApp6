import { Injectable, Logger } from '@nestjs/common';
import type { ParsedPlatformQuery, PlatformCapability, PlatformEntity, PlatformLookupHitDto } from '@superapp/shared';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';

/**
 * Провайдер поиска — регистрирует владелец сущности (core/users → user, modules/workspaces
 * → workspace). Ответ уже МАСКИРОВАН (телефон, БИН): раскрытие — только командой.
 */
export interface PlatformLookupProvider {
  entity: PlatformEntity;
  match(query: ParsedPlatformQuery, limit: number): Promise<PlatformLookupHitDto[]>;
  /** Шапка карточки 360 (null — сущности нет) */
  header(id: string): Promise<PlatformLookupHitDto | null>;
}

/** Панель карточки 360: белый список полей (S11), читает `system*`-методы; право проверил кабинет. */
export interface PlatformPanelDef {
  key: string;
  entity: PlatformEntity;
  titleKey: string;
  capability: PlatformCapability;
  order: number;
  /** Грузить сразу при открытии карточки */
  eager?: boolean;
  load(actor: PlatformActor, id: string): Promise<unknown>;
}

@Injectable()
export class PlatformLookupRegistry {
  private readonly logger = new Logger(PlatformLookupRegistry.name);
  private readonly providers = new Map<PlatformEntity, PlatformLookupProvider>();

  register(provider: PlatformLookupProvider): void {
    if (this.providers.has(provider.entity)) this.logger.warn(`lookup provider "${provider.entity}" already registered; overwriting`);
    this.providers.set(provider.entity, provider);
  }

  get(entity: PlatformEntity): PlatformLookupProvider | undefined {
    return this.providers.get(entity);
  }

  all(): PlatformLookupProvider[] {
    return [...this.providers.values()];
  }
}

@Injectable()
export class PlatformPanelRegistry {
  private readonly logger = new Logger(PlatformPanelRegistry.name);
  private readonly panels = new Map<string, PlatformPanelDef>();

  register(def: PlatformPanelDef): void {
    if (this.panels.has(def.key)) this.logger.warn(`panel "${def.key}" already registered; overwriting`);
    this.panels.set(def.key, def);
  }

  get(key: string): PlatformPanelDef | undefined {
    return this.panels.get(key);
  }

  forEntity(entity: PlatformEntity): PlatformPanelDef[] {
    return [...this.panels.values()].filter((p) => p.entity === entity).sort((a, b) => a.order - b.order);
  }
}
