import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PlatformCapability as PlatformCapabilityKey, PlatformRoleKey } from '@superapp/shared';

// ============================================================
// Маршруты кабинета платформы (core/platform) — deny by default.
//
// Контроллер кабинета помечается `@PlatformRoute()` (класс): продуктовый JwtAuthGuard
// его пропускает, а PlatformAuthGuard (APP_GUARD) берёт на себя: стоп-кран
// `PLATFORM_CONSOLE_ENABLED`, отказ заголовку организации, токен кабинета, сессия,
// сотрудник, capability. КАЖДЫЙ метод обязан объявить доступ одним из трёх
// декораторов ниже — маршрут без объявления роняет бутстрап (smoke в PlatformModule).
// `@Public()` под /platform запрещён (страж check-docs).
// ============================================================

export const IS_PLATFORM_ROUTE_KEY = 'platformRoute';
export const PLATFORM_ACCESS_KEY = 'platformAccess';

export type PlatformAccessMeta =
  | { kind: 'public' }
  | { kind: 'session' }
  | { kind: 'capability'; capability: PlatformCapabilityKey };

/** Класс-контроллер под `/platform/*` */
export const PlatformRoute = () => SetMetadata(IS_PLATFORM_ROUTE_KEY, true);
/** Без токена — ТОЛЬКО вход (start/login) в platform-auth.controller */
export const PlatformPublic = () => SetMetadata<string, PlatformAccessMeta>(PLATFORM_ACCESS_KEY, { kind: 'public' });
/** Любой активный сотрудник с живой сессией (me, logout, step-up, список команд) */
export const PlatformSession = () => SetMetadata<string, PlatformAccessMeta>(PLATFORM_ACCESS_KEY, { kind: 'session' });
/** Сотрудник с конкретным правом */
export const PlatformCapability = (capability: PlatformCapabilityKey) =>
  SetMetadata<string, PlatformAccessMeta>(PLATFORM_ACCESS_KEY, { kind: 'capability', capability });

/** Актор кабинета — кладётся гардом в `req.platformActor` (НЕ в `req.user`: продуктовые пути его не видят). */
export interface PlatformActor {
  userId: string;
  sessionId: string;
  roles: PlatformRoleKey[];
  capabilities: PlatformCapabilityKey[];
  /** Окно sudo (step-up) — null, если подтверждения нет */
  sudoUntil: Date | null;
  sessionExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  /** Идентификатор запроса для журнала (заголовок X-Request-Id либо сгенерированный) */
  requestId: string;
}

export const CurrentPlatformActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): PlatformActor => {
  const request = ctx.switchToHttp().getRequest<{ platformActor?: PlatformActor }>();
  if (!request.platformActor) throw new Error('platform actor is missing: the route is not guarded by PlatformAuthGuard');
  return request.platformActor;
});
