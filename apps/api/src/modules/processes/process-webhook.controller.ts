import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Telegram-триггер: входящее сообщение боту → запуск процесса' })
  async fireTelegram(@Param('token') token: string, @Body() body: unknown) {
    // Telegram повторяет доставку при не-2xx → всегда отвечаем 200 (даже если апдейт проигнорирован).
    const update = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const instanceId = await this.router.fireTelegram(token, update);
    return { success: true, instanceId: instanceId ?? null };
  }

  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вебхук-триггер: запустить процесс (тело → анкета)' })
  async fire(@Param('token') token: string, @Body() body: unknown) {
    const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const instanceId = await this.router.fireWebhook(token, payload);
    if (!instanceId) throw new NotFoundException('Вебхук не найден или отключён');
    return { success: true, instanceId };
  }
}
