import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KEYS_ERROR_CODES, KEY_SCOPE_SERVICES, keyScopeLevelOf, keyScopeSatisfies, keyScopeServiceOf, type KeyScopeService } from '@superapp/shared';
import { IS_PUBLIC_KEY } from '../../../shared/decorators/public.decorator';
import { KEY_SCOPE_KEY, NO_API_KEYS_KEY } from '../../../shared/decorators/api-keys.decorator';
import { forbidden } from '../../../shared/errors/api-error';
import type { JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { routeTemplateOf } from '@superapp/shared';
import { KeysUsageCron } from './keys.usage.cron';

/**
 * Скоуп-гард (APP_GUARD после гардов аутентификации): для запроса ПО КЛЮЧУ сверяет
 * сервис маршрута (`KEY_SCOPE_SERVICES`, префикс пути) и уровень (GET → read, иначе
 * write) со скоупами ключа. Сервис вне реестра, `@NoApiKeys()`, сервис, закрытый ботам,
 * или недостаточный уровень → 403 `keys.scope.denied`. Deny-by-default. Живые сессии
 * человека гард не касается. Право по объекту дальше решают сервисы и core/access.
 */
@Injectable()
export class KeyScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usage: KeysUsageCron,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: JwtPayload; method: string; path?: string; originalUrl?: string }>();
    const user = req.user;
    if (!user?.keyId) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    // Отказ по скоупу — тоже строка журнала обращений: владелец видит, куда ключ ломился
    const deny = () => {
      void this.usage.record({ keyId: user.keyId!, method: req.method, route: routeTemplateOf(this.pathOf(req)), status: 403, ip: (req as { ip?: string }).ip ?? null });
      return forbidden('keys.scope.denied', undefined, { code: KEYS_ERROR_CODES.scopeDenied });
    };
    if (this.reflector.getAllAndOverride<boolean>(NO_API_KEYS_KEY, [context.getHandler(), context.getClass()])) throw deny();

    const path = this.pathOf(req);
    // Личность носителя (кто я) — любому живому ключу: интеграция обязана уметь представиться
    if (req.method === 'GET' && (path === '/users/me' || path === '/users/me/')) return true;

    const override = this.reflector.getAllAndOverride<KeyScopeService | undefined>(KEY_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    const service = override ?? keyScopeServiceOf(path);
    if (!service) throw deny();
    if (user.kind === 'bot' && !KEY_SCOPE_SERVICES[service].bot) throw deny();
    const level = keyScopeLevelOf(req.method);
    if (!keyScopeSatisfies(user.scopes?.[service], level)) throw deny();
    return true;
  }

  /** Путь без префикса `/api` (алиас `/api/v1` уже переписан в main.ts). */
  private pathOf(req: { path?: string; originalUrl?: string }): string {
    const raw = (req.path ?? req.originalUrl ?? '').split('?')[0] ?? '';
    return raw.replace(/^\/api(?:\/v1)?/, '') || '/';
  }
}
