import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SHARE_SESSION_HEADER, shareGuestIdentityStartSchema, shareGuestSessionSchema } from '@superapp/shared';
import { Public } from '../../shared/decorators/public.decorator';
import { ShareLinksGuestService } from './share-links-guest.service';

/**
 * Гостевая поверхность: сюда приходит человек БЕЗ аккаунта по адресу `/s/<токен>`.
 *
 * Аутентификации платформы здесь нет и быть не может — вход открывает сам токен, а
 * последующие запросы предъявляют подписанный пропуск в заголовке. Поэтому ответы
 * НИКОГДА не бывают 401: только 403 (пароль/пропуск), 404 (ссылки нет) и 410 (отозвана,
 * истекла, исчерпана, объект удалён).
 */
@ApiTags('ShareLinks')
@Controller('share-links/guest')
export class ShareLinksGuestController {
  constructor(private readonly guest: ShareLinksGuestService) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Состояние ссылки (жива ли, нужен ли пароль). Открытие НЕ засчитывается' })
  async peek(@Param('token') token: string) {
    const data = await this.guest.peek(token);
    return { success: true, data };
  }

  /**
   * SMS-код для гостя (ссылка с «подтвердите номер»). Троттлинг жёстче остальных
   * гостевых ручек: SMS = деньги; внутри работают ещё и точные лимиты core/verify
   * (кулдаун, потолки на номер, IP-эшелоны, глобальный бюджет).
   */
  @Public()
  @Throttle({ long: { limit: 10, ttl: 60_000 } })
  @Post(':token/identity/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Запросить SMS-код подтверждения номера гостя (код проверяется в /verify/check)' })
  async identityStart(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const dto = shareGuestIdentityStartSchema.parse(body ?? {});
    const data = await this.guest.startIdentity(token, dto, req.ip ?? null);
    return { success: true, data };
  }

  /**
   * Открытие. Троттлинг жёстче платформенного намеренно: здесь и перебор пароля
   * (bcrypt — дорогая проверка, то есть ещё и вектор нагрузки), и накрутка счётчика
   * открытий чужой ссылки.
   */
  @Public()
  @Throttle({ long: { limit: 30, ttl: 60_000 } })
  @Post(':token/session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Открыть ссылку: засчитать открытие и получить пропуск с содержимым' })
  async openSession(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const dto = shareGuestSessionSchema.parse(body ?? {});
    const data = await this.guest.openSession(token, dto, {
      // req.ip — единственный честный источник: доверие к X-Forwarded-For настраивается
      // через TRUST_PROXY, иначе адрес в журнале писал бы сам посетитель.
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { success: true, data };
  }

  @Public()
  @Get(':token/view')
  @ApiOperation({ summary: 'Свежее содержимое по действующему пропуску (без счётчика)' })
  async view(@Param('token') token: string, @Headers(SHARE_SESSION_HEADER) session: string | undefined) {
    const data = await this.guest.refreshView(token, session);
    return { success: true, data };
  }
}
