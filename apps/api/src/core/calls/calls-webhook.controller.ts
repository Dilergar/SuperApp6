import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { WebhookEvent } from 'livekit-server-sdk';
import { Public } from '../../shared/decorators/public.decorator';
import { CallsLivekitClient } from './calls-livekit.client';
import { CallsService } from './calls.service';

/**
 * Приёмник вебхуков LiveKit. @Public — сервер шлёт без пользовательского JWT;
 * аутентификация = проверка подписи WebhookReceiver по СЫРОМУ телу (express.raw
 * на этот путь навешен в main.ts ПОСЛЕ alias-мидлвари /api/v1→/api — оба префикса
 * покрыты). События at-least-once → CallsService.handleWebhook идемпотентен.
 */
@Public()
@SkipThrottle()
@Controller('calls')
export class CallsWebhookController {
  constructor(
    private readonly livekit: CallsLivekitClient,
    private readonly calls: CallsService,
  ) {}

  @Post('livekit/webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request): Promise<{ success: true }> {
    if (!this.livekit.enabled) throw new BadRequestException('Звонки не подключены');
    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {});
    let event: WebhookEvent;
    try {
      event = await this.livekit.webhookReceiver.receive(raw, req.headers.authorization);
    } catch {
      throw new UnauthorizedException('Невалидная подпись вебхука LiveKit');
    }
    await this.calls.handleWebhook(event);
    return { success: true };
  }
}
