import { Injectable } from '@nestjs/common';
import {
  PLATFORM_ERROR_CODES,
  PLATFORM_LIMITS,
  parsePlatformQuery,
  type PlatformEntity,
  type PlatformEntityDto,
  type PlatformLookupResponseDto,
  type PlatformPanelDataDto,
  type PlatformUserHitDto,
  type PlatformWorkspaceHitDto,
} from '@superapp/shared';
import { forbidden, notFound } from '../../shared/errors/api-error';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';
import { PlatformAccessService } from './platform-access.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformCommandsService } from './platform-commands.service';
import { PlatformLookupRegistry, PlatformPanelRegistry } from './platform-lookup.registry';
import { PlatformRateService } from './platform-rate.service';

/**
 * Поиск и карточка 360. Правила S10: телефон только полный, ИИН/БИН — 12 цифр, текст
 * от 3 символов, ≤ 20 совпадений, ответ маскирован; троттлинг на сотрудника (Redis
 * счётчик по минутному окну); каждый просмотр — строка PlatformAccessLog.
 */
@Injectable()
export class PlatformLookupService {
  constructor(
    private readonly registry: PlatformLookupRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly audit: PlatformAuditService,
    private readonly access: PlatformAccessService,
    private readonly commands: PlatformCommandsService,
    private readonly rate: PlatformRateService,
  ) {}

  async lookup(actor: PlatformActor, q: string): Promise<PlatformLookupResponseDto> {
    await this.rate.assertLookupBudget(actor);
    const query = parsePlatformQuery(q);
    const empty: PlatformLookupResponseDto = { query, users: [], workspaces: [] };
    if (query.kind === 'empty' || query.kind === 'tooShort') return empty;
    this.audit.logAccess({ actorId: actor.userId, kind: 'search', requestId: actor.requestId, fields: [query.kind] });
    const results = await Promise.all(this.registry.all().map((p) => p.match(query, PLATFORM_LIMITS.lookupMaxHits).catch(() => [])));
    const hits = results.flat();
    return {
      query,
      users: hits.filter((h): h is PlatformUserHitDto => h.entity === 'user').slice(0, PLATFORM_LIMITS.lookupMaxHits),
      workspaces: hits.filter((h): h is PlatformWorkspaceHitDto => h.entity === 'workspace').slice(0, PLATFORM_LIMITS.lookupMaxHits),
    };
  }

  async entity(actor: PlatformActor, entity: PlatformEntity, id: string): Promise<PlatformEntityDto> {
    await this.rate.assertViewBudget(actor);
    const provider = this.registry.get(entity);
    if (!provider) throw notFound('platform.entity_not_found');
    const header = await provider.header(id);
    if (!header) throw notFound('platform.entity_not_found');
    this.audit.logAccess({ actorId: actor.userId, kind: 'view', targetType: entity, targetId: id, requestId: actor.requestId });

    const chips: PlatformEntityDto['chips'] = [];
    if (header.entity === 'user') {
      const staff = await this.access.staffOf(id);
      if (staff) chips.push({ key: staff.status === 'suspended' ? 'suspended' : 'staff', tone: staff.status === 'suspended' ? 'warning' : 'accent' });
      if (header.deletedAt) chips.push({ key: 'deleted', tone: 'danger' });
    } else if (!header.isActive) {
      chips.push({ key: 'inactive', tone: 'warning' });
    }
    const panels = this.panels
      .forEntity(entity)
      .filter((p) => actor.capabilities.includes(p.capability))
      .map((p, i) => ({ key: p.key, titleKey: p.titleKey, order: p.order, eager: p.eager ?? i < 3 }));
    const commands = this.commands.listFor(actor).filter((c) => c.entities.includes(entity));
    return { entity, id, header, chips, panels, commands };
  }

  async panel(actor: PlatformActor, entity: PlatformEntity, id: string, key: string): Promise<PlatformPanelDataDto> {
    // Панель читает те же данные, что карточка, и лимит у неё общий: иначе выгрузка
    // шла бы прямыми запросами к панелям в обход потолка просмотров (S10).
    await this.rate.assertViewBudget(actor);
    const def = this.panels.get(key);
    if (!def || def.entity !== entity) throw notFound('platform.panel_not_found');
    if (!actor.capabilities.includes(def.capability)) {
      throw forbidden('platform.capability_denied', { capability: def.capability }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    }
    this.audit.logAccess({ actorId: actor.userId, kind: 'view', targetType: entity, targetId: id, fields: [key], requestId: actor.requestId });
    return { key, data: await def.load(actor, id), loadedAt: new Date().toISOString() };
  }
}
