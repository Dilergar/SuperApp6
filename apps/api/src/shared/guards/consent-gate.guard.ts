import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONSENT_ERROR_CODES } from '@superapp/shared';
import { ConsentsGateService } from '../../core/consents/gate/consents-gate.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_PLATFORM_ROUTE_KEY } from '../decorators/platform.decorator';
import { SKIP_CONSENT_GATE_KEY } from '../decorators/skip-consent-gate.decorator';
import { forbidden } from '../errors/api-error';
import type { JwtPayload } from '../decorators/current-user.decorator';

/**
 * Шлюз согласий (APP_GUARD после KeyScopeGuard): человек с непринятыми обязательными
 * документами, чья дата вступления прошла, получает `403 consents.pending` на всём, кроме
 * белого списка `@SkipConsentGate()`. Вне шлюза: публичные маршруты, кабинет платформы
 * (иначе не опубликовать исправление) и боты (`kind: 'bot'` — не субъект согласия).
 * Личный ключ API — под шлюзом: это сессия человека.
 *
 * Быстрый путь без ввода-вывода: эпоха человека (`cep` — приехала из кэша «аккаунт жив»)
 * не меньше глобальной (микрокэш процесса). Отставший — проверка по базе в `ConsentsGateService`.
 */
@Injectable()
export class ConsentGateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly gate: ConsentsGateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CONSENT_GATE_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest<{ user?: JwtPayload }>().user;
    if (!user?.sub || user.kind === 'bot') return true;

    const g = await this.gate.globalEpoch();
    if (g === 0) return true;
    if (typeof user.cep === 'number' && user.cep >= g) return true;
    if (await this.gate.isUserBlocked(user.sub)) {
      throw forbidden('consents.pending', undefined, { code: CONSENT_ERROR_CODES.pending });
    }
    return true;
  }
}
