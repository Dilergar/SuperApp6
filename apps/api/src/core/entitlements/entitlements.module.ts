import { Global, Module } from '@nestjs/common';
import { isDevEnv } from '../../shared/config/env.validation';
import { EntitlementsCache } from './entitlements.cache';
import { EntitlementsCatalogService } from './entitlements.catalog.service';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsDevController } from './entitlements.dev';
import { EntitlementsLifecycle } from './entitlements.lifecycle';
import { EntitlementsNotifier } from './entitlements.notifications';
import { EntitlementsPlatformController, EntitlementsPlatformProvider } from './entitlements.platform.provider';
import { EntitlementsQuotaService } from './entitlements.quota.service';
import { QuotaReconcileRegistry, UsageProviderRegistry } from './entitlements.registry';
import { EntitlementsService } from './entitlements.service';
import { EntitlementsLifecycleProvider } from './entitlements.lifecycle.provider';

/**
 * core/entitlements — 19-й платформенный движок: «кто что может и сколько».
 * Планы версиями, подписки субъектов, гранты, оверрайды, расходуемые квоты, снимок
 * для клиентов, отказ 402. @Global: сервисы зовут `EntitlementsService`, владельцы
 * данных регистрируют провайдеры расхода и сверки. Движок фичи не импортирует.
 */
@Global()
@Module({
  controllers: isDevEnv()
    ? [EntitlementsController, EntitlementsPlatformController, EntitlementsDevController]
    : [EntitlementsController, EntitlementsPlatformController],
  providers: [
    EntitlementsLifecycleProvider,
    UsageProviderRegistry,
    QuotaReconcileRegistry,
    EntitlementsCache,
    EntitlementsCatalogService,
    EntitlementsQuotaService,
    EntitlementsNotifier,
    EntitlementsService,
    EntitlementsLifecycle,
    EntitlementsPlatformProvider,
  ],
  exports: [EntitlementsService, EntitlementsQuotaService, EntitlementsCatalogService, UsageProviderRegistry, QuotaReconcileRegistry],
})
export class EntitlementsModule {}
