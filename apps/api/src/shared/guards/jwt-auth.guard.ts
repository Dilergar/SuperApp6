import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_PLATFORM_ROUTE_KEY } from '../decorators/platform.decorator';
import { unauthorized } from '../errors/api-error';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Маршруты кабинета платформы живут под СВОИМ гардом (PlatformAuthGuard, APP_GUARD
    // следующим): продуктовый токен туда не пускается, токен кабинета — сюда.
    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPlatform) return true;

    return super.canActivate(context);
  }

  handleRequest<TUser = unknown>(err: Error | null, user: TUser): TUser {
    if (err || !user) {
      // Отказ гарда случается ДО интерцептора контекста, поэтому язык фильтр
      // берёт из заголовка запроса, а не из ALS. Код — всегда, текст — на языке
      // просящего: «войдите» на незнакомом языке бесполезно.
      throw err || unauthorized('auth.unauthorized');
    }
    return user;
  }
}
