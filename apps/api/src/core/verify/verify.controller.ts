import { Controller, Get, NotFoundException, Post, Body, Query, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { notFound } from '../../shared/errors/api-error';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { VerifyService } from './verify.service';
import { Public } from '../../shared/decorators/public.decorator';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { verifyStartSchema, verifyStepUpSchema, verifyCheckSchema } from '@superapp/shared';
import { SkipConsentGate } from '../../shared/decorators/skip-consent-gate.decorator';

/**
 * IP клиента для эшелонов лимитов — ТОЛЬКО через `req.ip`.
 *
 * Раньше здесь читался первый X-Forwarded-For напрямую. Заголовок пишет кто угодно, и
 * без настроенного `trust proxy` это означало, что счётчики verify:ip:* обнуляются
 * случайной строкой в запросе, то есть IP-эшелона (и NestJS-троттлера) фактически не
 * было. Express сам разбирает XFF ровно настолько, насколько мы объявили доверенных
 * прокси (env TRUST_PROXY, см. main.ts), иначе возвращает адрес сокета.
 */
function clientIp(req: Request): string | undefined {
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}

@ApiTags('Verify')
// SMS-подтверждения нужны за блокирующим экраном согласий: удаление аккаунта идёт через step-up
@SkipConsentGate()
@Controller('verify')
export class VerifyController {
  constructor(private verify: VerifyService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'The verification engine mode (the web adapts its forms)' })
  status() {
    return { success: true, data: this.verify.status() };
  }

  @Public()
  @Post('start')
  @HttpCode(HttpStatus.OK)
  // SMS = деньги: грубая сетка NestJS-троттлера поверх точных внутренних лимитов движка.
  @Throttle({ long: { limit: 15, ttl: 900000 } })
  @ApiOperation({ summary: 'Start a phone confirmation (sign-up / password reset)' })
  async start(@Body() body: unknown, @Req() req: Request) {
    const data = verifyStartSchema.parse(body);
    if (data.purpose !== 'register' && data.purpose !== 'password_reset') {
      // step-up цели доступны только залогиненным через /verify/step-up
      throw notFound('verify.badTarget');
    }
    const result = await this.verify.startPublic(data.phone, data.purpose, clientIp(req), data.consents);
    return { success: true, data: result };
  }

  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 15, ttl: 900000 } })
  @ApiOperation({ summary: 'Start a confirmation for an account action (password or phone change)' })
  async stepUp(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request) {
    const data = verifyStepUpSchema.parse(body);
    // Пароль проверяет сервис ДО отправки SMS: иначе неверный пароль выяснялся бы
    // после сожжённого кода, а угнанный токен работал бы кнопкой SMS-спама.
    const result = await this.verify.startStepUp(user.sub, data.purpose, data.password, data.newPhone, clientIp(req));
    return { success: true, data: result };
  }

  @Public()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 60, ttl: 900000 } })
  @ApiOperation({ summary: 'Check the code from the SMS → a one-time verifyToken' })
  async check(@Body() body: unknown, @Req() req: Request) {
    const data = verifyCheckSchema.parse(body);
    const result = await this.verify.check(data.challengeId, data.code, clientIp(req));
    return { success: true, data: result };
  }

  /** Dev-полигон (прецедент /jobs/stats): код цепочки для verify-скриптов и ручной проверки фронта. */
  @Public()
  @Get('dev/last-code')
  @ApiOperation({ summary: '[dev] The chain code (NODE_ENV=development/test only)' })
  async devLastCode(@Query('challengeId') challengeId: string) {
    if (!this.verify.isDevEnv) throw new NotFoundException();
    if (!challengeId) throw new NotFoundException();
    const result = await this.verify.devLastCode(challengeId);
    return { success: true, data: result };
  }
}
