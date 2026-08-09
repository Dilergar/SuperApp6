import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  signCheckQuerySchema,
  signCmsSchema,
  signDeclineSchema,
  signPepConfirmSchema,
  signPepStartSchema,
  signQrStartSchema,
  signQrSubmitSchema,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { SignService, type SignActor, type SignCtx } from './sign.service';
import { SignQrService } from './sign-qr.service';
import { SignProtocolService } from './sign-protocol.service';

/**
 * HTTP-поверхность движка подписи.
 *
 * Ручки «завести заявку» здесь НЕТ намеренно — ровно по тому же доводу, по
 * которому её нет у core/approvals: право «отправить это на подпись» знает
 * только потребитель, и публичный путь шёл бы мимо него. Заявку заводит
 * сервисный вызов `SignService.createRequest` из кода потребителя.
 */
@ApiTags('Sign')
@Controller('sign')
export class SignController {
  constructor(
    private readonly sign: SignService,
    private readonly qr: SignQrService,
    private readonly protocol: SignProtocolService,
  ) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Режим движка подписи (веб прячет недоступные способы)' })
  status() {
    return { success: true, data: this.sign.status() };
  }

  @Post('requests/for-step/:stepId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Открыть подписание шага маршрута (лениво и идемпотентно)' })
  async forStep(@CurrentUser() user: JwtPayload, @Param('stepId') stepId: string) {
    return { success: true, data: await this.sign.ensureForStep(actorOf(user), stepId) };
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'Экран подписания: заявка, замороженный документ, мой акт' })
  async flow(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.sign.getFlow(actorOf(user), id) };
  }

  @Get('acts/:actId/state')
  @ApiOperation({ summary: 'Короткое состояние акта (поллинг во время подписания по QR)' })
  async actState(@CurrentUser() user: JwtPayload, @Param('actId') actId: string) {
    return { success: true, data: await this.sign.myActState(actorOf(user), actId) };
  }

  @Get('acts/:actId/events')
  @ApiOperation({ summary: 'Протокол подписания (append-only)' })
  async events(@CurrentUser() user: JwtPayload, @Param('actId') actId: string) {
    return { success: true, data: await this.sign.events(actorOf(user), actId) };
  }

  // ---- ПЭП ----

  @Post('acts/:actId/pep/start')
  @HttpCode(HttpStatus.OK)
  // SMS = деньги: грубая сетка поверх точных лимитов core/verify.
  @Throttle({ long: { limit: 15, ttl: 900000 } })
  @ApiOperation({ summary: 'ПЭП, шаг 1: принять соглашение и получить код' })
  async pepStart(
    @CurrentUser() user: JwtPayload,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const dto = signPepStartSchema.parse(body);
    return { success: true, data: await this.sign.pepStart(actorOf(user), actId, dto, ctxOf(req)) };
  }

  @Post('acts/:actId/pep/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 60, ttl: 900000 } })
  @ApiOperation({ summary: 'ПЭП, шаг 2: код из SMS → подпись' })
  async pepConfirm(
    @CurrentUser() user: JwtPayload,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const dto = signPepConfirmSchema.parse(body);
    return { success: true, data: await this.sign.pepConfirm(actorOf(user), actId, dto, ctxOf(req)) };
  }

  // ---- ЭЦП ----

  @Post('acts/:actId/cms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'ЭЦП через NCALayer: готовый контейнер из браузера' })
  async cms(
    @CurrentUser() user: JwtPayload,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const dto = signCmsSchema.parse(body);
    const data = await this.sign.submitCms(actorOf(user), actId, dto.cms, 'ncalayer', ctxOf(req));
    return { success: true, data };
  }

  @Post('acts/:actId/qr/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'ЭЦП через eGov Mobile: одноразовый QR' })
  async qrStart(
    @CurrentUser() user: JwtPayload,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    signQrStartSchema.parse(body ?? {});
    return { success: true, data: await this.qr.start(actorOf(user), actId, ctxOf(req)) };
  }

  // ---- Отказ ----

  @Post('acts/:actId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отказ от подписи (причина обязательна)' })
  async decline(
    @CurrentUser() user: JwtPayload,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const dto = signDeclineSchema.parse(body);
    return { success: true, data: await this.sign.decline(actorOf(user), actId, dto, ctxOf(req)) };
  }

  // ---- Артефакты (ст. 62 ЦК: документ обязан жить вне системы) ----

  @Get('requests/:id/protocol')
  @ApiOperation({ summary: 'Протокол подписания — PDF' })
  async protocolPdf(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    const { buffer, fileName } = await this.protocol.buildProtocol(actorOf(user), id);
    sendBinary(req, buffer, fileName, 'application/pdf');
    return;
  }

  @Get('requests/:id/export')
  @ApiOperation({ summary: 'Экспортный пакет: документ + подписи + квитанции + протокол' })
  async exportZip(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    const { buffer, fileName } = await this.protocol.buildExport(actorOf(user), id);
    sendBinary(req, buffer, fileName, 'application/zip');
    return;
  }

  // ---- Публичная проверка (ст. 61 ЦК) ----

  @Public()
  @Get('check')
  // Неаутентифицированная и не бесплатная ручка: перебор отпечатков ничего не
  // даёт (256 бит), но и молотить базу ею не позволим.
  @Throttle({ long: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Открытая проверка подписи по отпечатку файла или ссылке' })
  async check(@Query() query: unknown) {
    const q = signCheckQuerySchema.parse(query);
    return { success: true, data: await this.sign.check(q) };
  }
}

// ============================================================
// Мост eGov Mobile — публичные одноразовые адреса
// ============================================================

/**
 * Эти два адреса И ЕСТЬ требование паспорта сервиса Smart Bridge: публичные
 * HTTPS-URL, ограниченные по времени и числу обращений. Аутентификация здесь
 * невозможна по построению — на другом конце телефон с приложением eGov, у
 * которого нет нашей сессии; вместо неё работает одноразовый неугадываемый
 * токен и жёсткая статус-машина сессии.
 */
@ApiTags('Sign')
@Controller('sign/qr')
export class SignQrBridgeController {
  constructor(private readonly qr: SignQrService) {}

  @Public()
  @Get('data/:dataToken')
  @Throttle({ long: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: '[eGov Mobile] Забрать данные на подпись (одноразово)' })
  async data(@Param('dataToken') dataToken: string) {
    return { success: true, data: await this.qr.claimData(dataToken) };
  }

  @Public()
  @Post('submit/:signToken')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: '[eGov Mobile] Положить контейнер подписи (одноразово)' })
  async submit(@Param('signToken') signToken: string, @Body() body: unknown, @Req() req: Request) {
    // Схема и разбирает диалект моста (имя поля между версиями разное), и держит
    // потолок размера: ручка публичная, и без него в base64-декод уходила бы строка
    // любой длины.
    const cms = signQrSubmitSchema.parse(body ?? {});
    return { success: true, data: await this.qr.submit(signToken, cms, ctxOf(req)) };
  }
}

// ============================================================
// Общее
// ============================================================

export function actorOf(user: JwtPayload): SignActor {
  return { type: 'user', userId: user.sub };
}

export function ctxOf(req: Request): SignCtx {
  // IP — ТОЛЬКО из req.ip: заголовок X-Forwarded-For пишет кто угодно, и
  // «доказательство, с какого адреса подписали» из него было бы фальшивым.
  return { ip: req.ip ?? req.socket?.remoteAddress ?? null, userAgent: req.get('user-agent') ?? null };
}

/** Отдать байты напрямую: у Nest здесь res, а не сериализованный конверт */
export function sendBinary(req: Request, buffer: Buffer, fileName: string, mime: string): void {
  const res = req.res!;
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
}
