import { Global, Logger, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { VISIBILITY_TYPE_KEYS, visibilityRegistryProblems } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { UsageProviderRegistry } from '../entitlements/entitlements.registry';
import { VisibilityCache } from './visibility.cache';
import { VisibilityController } from './visibility.controller';
import { VisibilityDevController } from './visibility.dev';
import { VisibilityDiscoverabilityService } from './visibility.discoverability.service';
import { VisibilityMetrics } from './visibility.metrics';
import { VisibilityPlatformProvider } from './visibility.platform.provider';
import { VisibilityApprovalsProvider } from './visibility.approvals.provider';
import { VisibilityPolicyService } from './visibility.policy.service';
import { VisibilityRealtimeProvider } from './visibility.realtime.provider';
import { VisibilityPersonalGraphRegistry, VisibilityRelationRegistry, VisibilityTypeRegistry } from './visibility.registry';
import { VisibilityResponseGuard } from './visibility.response.guard';
import { VisibilityRevealService } from './visibility.reveal.service';
import { VisibilityScrapeDetector } from './visibility.scrape.service';
import { VisibilityService } from './visibility.service';
import { VisibilityWorkspaceController } from './visibility.workspace.controller';
import { VisibilityLifecycleProvider } from './visibility.lifecycle.provider';

/**
 * core/visibility — 27-й платформенный движок: правила видимости ПОЛЕЙ (Field-Level Security
 * + маскирование) для всей экосистемы. Один реестр типов записей (shared), один план полей на
 * зрителя, один проектор ответа на все каналы (API, хроника, уведомления, вебхуки, гости, ИИ).
 * @Global: сервисы зовут `VisibilityService.shape(...)`, провайдеры типов и отношений
 * регистрируют сами фичи (движок фичи не импортирует — граница держится `check:docs`).
 *
 * Смоук на бутстрапе: реестр нарушает правила (маска не по виду данных, секрет с раскрытием,
 * личное поле в служебном типе, производное поле ниже класса входа…) ИЛИ у типа нет
 * провайдера в API — старт падает (как `KeysRoutesAudit`). docs/visibility_engine.md.
 */
@Global()
@Module({
  controllers: isDevEnv() ? [VisibilityController, VisibilityWorkspaceController, VisibilityDevController] : [VisibilityController, VisibilityWorkspaceController],
  providers: [
    VisibilityLifecycleProvider,
    VisibilityMetrics,
    VisibilityCache,
    VisibilityTypeRegistry,
    VisibilityRelationRegistry,
    VisibilityPersonalGraphRegistry,
    VisibilityScrapeDetector,
    VisibilityService,
    VisibilityPolicyService,
    VisibilityRevealService,
    VisibilityDiscoverabilityService,
    VisibilityRealtimeProvider,
    VisibilityPlatformProvider,
    VisibilityApprovalsProvider,
    VisibilityResponseGuard,
  ],
  exports: [
    VisibilityService,
    VisibilityPolicyService,
    VisibilityRevealService,
    VisibilityDiscoverabilityService,
    VisibilityTypeRegistry,
    VisibilityRelationRegistry,
    VisibilityPersonalGraphRegistry,
    VisibilityMetrics,
    VisibilityResponseGuard,
  ],
})
export class VisibilityModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(VisibilityModule.name);

  constructor(
    private readonly types: VisibilityTypeRegistry,
    private readonly usage: UsageProviderRegistry,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    // «Сколько правил уже есть» — опубликованные и черновые политики организации (архив не считается)
    this.usage.register('visibility.maxRules', {
      count: async (subject, tx) =>
        (tx ?? this.db).visibilityRule.count({ where: { policy: { ownerType: subject.type, ownerId: subject.id, status: { in: ['published', 'draft'] } } } }),
    });
  }

  onApplicationBootstrap(): void {
    const problems = visibilityRegistryProblems();
    const registered = new Set(this.types.registeredTypes());
    for (const t of VISIBILITY_TYPE_KEYS) if (!registered.has(t)) problems.push(`record type "${t}" has no VisibilityTypeProvider in the API`);
    if (problems.length) {
      const msg = `visibility registry is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }
}
