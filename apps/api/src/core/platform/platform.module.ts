import { Global, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../shared/decorators/public.decorator';
import { IS_PLATFORM_ROUTE_KEY, PLATFORM_ACCESS_KEY } from '../../shared/decorators/platform.decorator';
import { PlatformAccessService } from './platform-access.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformCommandRegistry } from './platform-commands.registry';
import { PlatformCommandsService } from './platform-commands.service';
import { PlatformLookupRegistry, PlatformPanelRegistry } from './platform-lookup.registry';
import { PlatformLookupService } from './platform-lookup.service';
import { PlatformPolicyService } from './platform-policy.service';
import { PlatformRateService } from './platform-rate.service';
import { PlatformRequestsService } from './platform-requests.service';
import {
  PlatformAuditController,
  PlatformAuthController,
  PlatformEntitiesController,
  PlatformLookupController,
  PlatformMeController,
  PlatformRequestsController,
} from './platform.controllers';
import { PlatformNotifier } from './platform.notifications';
import { PlatformProvider } from './platform.provider';
import { PlatformDevController } from './platform.dev';
import { isDevEnv } from '../../shared/config/env.validation';

/**
 * core/platform — 20-й платформенный движок: кабинет платформы. Сотрудники и роли
 * (отдельно от user_roles), вход со своим токеном, реестр команд с исполнителем и
 * append-only журналом, поиск и карточка 360 по реестрам, four-eyes на core/approvals.
 * @Global: фичи регистрируют команды/панели/провайдеры поиска; движок фичи не импортирует.
 *
 * Smoke на бутстрапе (S4): маршрут контроллера под @PlatformRoute без объявленного
 * доступа или с @Public — громкий отказ старта.
 */
@Global()
@Module({
  // Подпись токена кабинета — keystore core/keys (аудитория `platform`, @Global)
  imports: [DiscoveryModule],
  controllers: [
    PlatformAuthController,
    PlatformMeController,
    PlatformAuditController,
    PlatformLookupController,
    PlatformEntitiesController,
    PlatformRequestsController,
    ...(isDevEnv() ? [PlatformDevController] : []),
  ],
  providers: [
    PlatformCommandRegistry,
    PlatformLookupRegistry,
    PlatformPanelRegistry,
    PlatformAccessService,
    PlatformAuditService,
    PlatformPolicyService,
    PlatformRateService,
    PlatformNotifier,
    PlatformAuthService,
    PlatformAuthGuard,
    PlatformCommandsService,
    PlatformRequestsService,
    PlatformLookupService,
    PlatformProvider,
  ],
  exports: [
    PlatformCommandRegistry,
    PlatformLookupRegistry,
    PlatformPanelRegistry,
    PlatformAccessService,
    PlatformAuditService,
    PlatformAuthService,
    PlatformAuthGuard,
    // Чтения фич под /platform держат ОБЩИЙ бюджет просмотров (assertViewBudget)
    PlatformRateService,
    // APP_GUARD конструируется в контексте AppModule — его зависимости обязаны быть экспортированы
    PlatformNotifier,
  ],
})
export class PlatformModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformModule.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const controllerPath = String(this.reflector.get<string>(PATH_METADATA, metatype) ?? '');
      const isPlatformClass = !!this.reflector.get<boolean>(IS_PLATFORM_ROUTE_KEY, metatype);
      const underPlatform = controllerPath === 'platform' || controllerPath.startsWith('platform/');
      if (!isPlatformClass && !underPlatform) continue;
      if (underPlatform && !isPlatformClass) {
        problems.push(`${metatype.name}: controller under /platform without @PlatformRoute()`);
        continue;
      }
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: unknown[]) => unknown;
        if (typeof handler !== 'function') continue;
        if (this.reflector.get<string>(PATH_METADATA, handler) === undefined) continue; // не маршрут
        if (this.reflector.get<boolean>(IS_PUBLIC_KEY, handler) || this.reflector.get<boolean>(IS_PUBLIC_KEY, metatype)) {
          problems.push(`${metatype.name}.${method}: @Public() is forbidden under /platform`);
        }
        const access = this.reflector.getAllAndOverride(PLATFORM_ACCESS_KEY, [handler, metatype]);
        if (!access) problems.push(`${metatype.name}.${method}: route under /platform declares no access (@PlatformCapability/@PlatformSession/@PlatformPublic)`);
      }
    }
    if (problems.length) {
      const msg = `platform console routes are misdeclared (deny by default):\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }
}
