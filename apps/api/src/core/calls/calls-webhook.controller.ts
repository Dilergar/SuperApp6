import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { WebhookEvent } from 'livekit-server-sdk';
import { IDEMPOTENCY_ERROR_CODES, IDEMPOTENCY_LIMITS } from '@superapp/shared';
import { Public } from '../../shared/decorators/public.decorator';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { IdempotencyInboxService } from '../idempotency/idempotency.inbox.service';
import { badRequest, conflict, unauthorized } from '../../shared/errors/api-error';
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
    private readonly inbox: IdempotencyInboxService,
  ) {}

  @Post('livekit/webhook')
  @HttpCode(200)
  // Входящий вебхук: своего ключа повтора у LiveKit нет, дедуп — «входящий ящик»
  // движка идемпотентности по `event.id`, и ТОЛЬКО после проверки подписи (иначе
  // ящик травится поддельным идентификатором, и настоящее событие гасится как дубль)
  @SkipIdempotency('inbound_webhook')
  async webhook(@Req() req: Request): Promise<{ success: true }> {
    if (!this.livekit.enabled) throw badRequest('calls.notConnected');
    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {});
    let event: WebhookEvent;
    try {
      event = await this.livekit.webhookReceiver.receive(raw, req.headers.authorization);
    } catch {
      throw unauthorized('calls.badWebhookSignature');
    }
    // Подпись проверена — только теперь событие вправе попасть в ящик
    const ref = { source: 'livekit', account: event.room?.name ?? 'egress', eventId: event.id ?? '' };
    if (ref.eventId) {
      const verdict = await this.inbox.begin(ref);
      if (verdict === 'duplicate') return { success: true }; // редоставка обработанного
      // Первая доставка ещё в работе. Ответить 200 нельзя: упади она — отметка снимется,
      // а LiveKit, услышав «принято», больше не придёт. Не-2xx ⇒ он повторит позже.
      if (verdict === 'in_flight') {
        throw conflict(IDEMPOTENCY_ERROR_CODES.inFlight, undefined, { retryInSec: IDEMPOTENCY_LIMITS.retryAfterSec });
      }
    }
    try {
      await this.calls.handleWebhook(event);
    } catch (err) {
      // Обработка живёт не в одной транзакции с отметкой (внутри — вызовы LiveKit):
      // не сняв отметку, мы потеряли бы событие насовсем
      if (ref.eventId) await this.inbox.forget(ref).catch(() => undefined);
      throw err;
    }
    // Не дошли досюда (процесс умер) — строка останется «в работе», аренда истечёт,
    // и редоставка заберёт событие: `handleWebhook` идемпотентен
    if (ref.eventId) await this.inbox.done(ref).catch(() => undefined);
    return { success: true };
  }
}
