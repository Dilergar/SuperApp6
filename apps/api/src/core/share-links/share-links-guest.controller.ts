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
  @ApiOperation({ summary: 'The link state (is it alive, is a password needed). The open is NOT counted' })
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
  @ApiOperation({ summary: 'Request an SMS code confirming the guest phone (the code is checked in /verify/check)' })
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
  @ApiOperation({ summary: 'Open the link: count the open and get a pass together with the content' })
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
  @ApiOperation({ summary: 'Fresh content for a valid pass (the counter is untouched)' })
  async view(@Param('token') token: string, @Headers(SHARE_SESSION_HEADER) session: string | undefined) {
    const data = await this.guest.refreshView(token, session);
    return { success: true, data };
  }

  /**
   * ДЕЙСТВИЕ гостя над объектом. Движок здесь — проходная: он подтверждает
   * действующую ссылку и личность (если ссылка её требовала) и передаёт
   * управление потребителю по ключу действия. Что именно делает действие и кому
   * оно позволено — знает только потребитель.
   *
   * Троттлинг как у открытия: ручка неаутентифицированная, а за ней стоят
   * дорогие операции (проверка контейнера подписи, отправка SMS).
   */
  @Public()
  @Throttle({ long: { limit: 30, ttl: 60_000 } })
  @Post(':token/actions/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a consumer action on behalf of the guest' })
  async action(
    @Param('token') token: string,
    @Param('key') key: string,
    @Headers(SHARE_SESSION_HEADER) session: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const data = await this.guest.runAction(token, key, session, body, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { success: true, data };
  }
}
