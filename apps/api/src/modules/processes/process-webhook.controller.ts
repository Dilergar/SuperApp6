import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { TELEGRAM_SECRET_HEADER } from '@superapp/shared';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { notFound } from '../../shared/errors/api-error';
import { Public } from '../../shared/decorators/public.decorator';
import { ProcessTriggerRouter } from './process-triggers.service';

/**
 * Публичный приёмник вебхуков (Ф3): внешняя система дёргает URL с секрет-токеном →
 * стартует подписанный процесс, тело запроса → анкета. Глобальный троттлер защищает от спама.
 */
@ApiTags('Processes')
@Controller('processes/webhook')
export class ProcessWebhookController {
  constructor(private router: ProcessTriggerRouter) {}

  @Public()
  @Post('telegram/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Telegram trigger: an incoming message to the bot starts a process' })
  async fireTelegram(@Param('token') token: string, @Body() body: unknown, @Headers(TELEGRAM_SECRET_HEADER) secret?: string) {
    // Telegram повторяет доставку при не-2xx → всегда отвечаем 200 (даже если апдейт проигнорирован).
    const update = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const instanceId = await this.router.fireTelegram(token, update, secret);
    return { success: true, instanceId: instanceId ?? null };
  }

  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook trigger: start a process (the body becomes the form values)' })
  async fire(@Param('token') token: string, @Body() body: unknown) {
    const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const instanceId = await this.router.fireWebhook(token, payload);
    if (!instanceId) throw notFound('processes.webhookNotFound');
    return { success: true, instanceId };
  }
}
