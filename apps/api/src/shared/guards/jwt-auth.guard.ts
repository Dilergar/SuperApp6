import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KEYS_ARTIFACT_PREFIX } from '@superapp/shared';
import { trustedCountry } from '../context/request-context';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_PLATFORM_ROUTE_KEY } from '../decorators/platform.decorator';
import { unauthorized } from '../errors/api-error';
import { SessionValidatorService } from '../auth/session-validator.service';
import { ApiKeyAuthService } from '../../core/keys/api-keys/api-key-auth.service';
import type { JwtPayload } from '../decorators/current-user.decorator';

/**
 * Глобальный APP_GUARD (fail-closed): новая ручка защищена автоматически, открывается
 * только `@Public()`; маршруты кабинета — под своим гардом. Две личности:
 *  - `Authorization: Bearer <JWT>` — access-токен продукта (EdDSA по `kid`, на окне
 *    миграции ещё HS256) → подпись + живость через `SessionValidatorService`;
 *  - `Authorization: Bearer sa6_…` — ключ API организации/человека (core/keys):
 *    хеш → строка → срок/отзыв/IP → `req.user = { kind: 'bot'|'user', keyId, scopes }`.
 * passport-jwt отсюда ушёл: он не умеет EdDSA, а проверка живости всё равно жила в валидаторе.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionValidatorService,
    private readonly apiKeys: ApiKeyAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    // Маршруты кабинета платформы живут под СВОИМ гардом (PlatformAuthGuard, APP_GUARD
    // следующим): продуктовый токен туда не пускается, токен кабинета — сюда.
    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, [context.getHandler(), context.getClass()]);
    if (isPlatform) return true;

    const req = context.switchToHttp().getRequest<{ headers?: Record<string, unknown>; user?: JwtPayload; ip?: string }>();
    const raw = this.bearer(req.headers?.authorization);
    // Отказ гарда случается ДО интерцептора контекста, поэтому язык фильтр берёт из
    // заголовка запроса, а не из ALS. Код — всегда, текст — на языке просящего.
    if (!raw) throw unauthorized('auth.unauthorized');
    if (raw.startsWith(`${KEYS_ARTIFACT_PREFIX.apiKey}_`)) {
      // Страна — из ДОВЕРЕННОГО гео-заголовка края сети (`GEO_COUNTRY_HEADER`): «откуда» в реестре
      // ключей — сведение безопасности, заголовок клиента его не подделывает
      const country = trustedCountry((name) => {
        const v = (req.headers as Record<string, string | string[] | undefined>)[name];
        return Array.isArray(v) ? v[0] : v;
      });
      req.user = await this.apiKeys.authenticate(raw, req.ip ?? null, country);
      return true;
    }
    req.user = await this.sessions.verifyAccessToken(raw);
    return true;
  }

  private bearer(header: unknown): string | null {
    const h = Array.isArray(header) ? header[0] : header;
    if (typeof h !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1]!.trim() : null;
  }
}
