import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WEBHOOK_LIMITS } from '@superapp/shared';
import { z } from 'zod';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { forbidden } from '../../shared/errors/api-error';
import { JobDiscardError, JobSnoozeError } from '../jobs/jobs.registry';
import { WebhooksDeliveryJobs } from './webhooks.delivery.job';
import { WebhooksProbeCron } from './webhooks.probe.cron';

const probeBody = z.object({ endpointId: z.string().uuid() }).strict();
const deliverBody = z
  .object({
    deliveryId: z.string().uuid(),
    attempt: z.number().int().min(1).max(1000).default(1),
    maxAttempts: z.number().int().min(1).max(1000).default(WEBHOOK_LIMITS.maxAttempts),
  })
  .strict();
const streakBody = z
  .object({
    endpointId: z.string().uuid(),
    failures: z.number().int().min(0).max(100_000),
    /** Возраст серии провалов, часов (0 — серия началась только что) */
    failingHours: z.number().min(0).max(24 * 365),
    /** Сколько секунд назад был последний провал; null — таймер предохранителя пуст */
    lastFailureSecAgo: z.number().min(0).max(86_400 * 365).nullable().default(null),
  })
  .strict();

/**
 * Дев-полигон движка вебхуков (только development/test — модуль регистрирует контроллер
 * лишь в dev, в production его нет вовсе): учения за секунды вместо суток — аудит битой
 * подписью и суточный обход по требованию, прогон доставки с заданным номером попытки
 * (исчерпание пинга, последняя попытка), состаривание серии провалов (автоотключение
 * «порог штук И 24 часа», предохранитель мёртвого адреса). Живёт ЗДЕСЬ, а не в
 * дев-контроллере ключей: направление зависимостей «вебхуки → ключи», обратного импорта
 * у движка ключей быть не должно. Путь исторический (`/keys/dev/webhooks/*`) — на нём сьют.
 */
@ApiTags('Webhooks')
@ApiBearerAuth()
@Controller('keys/dev/webhooks')
export class WebhooksDevController {
  constructor(
    private readonly db: DatabaseService,
    private readonly deliveryJobs: WebhooksDeliveryJobs,
    private readonly cron: WebhooksProbeCron,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @Post('probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the bogus-signature audit for one endpoint now' })
  async probe(@Body() body: unknown) {
    this.assertDev();
    const { endpointId } = probeBody.parse(body ?? {});
    await this.deliveryJobs.probe({ endpointId });
    return { success: true };
  }

  @Post('daily')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the daily webhooks sweep now (probes + body minimisation)' })
  async daily() {
    this.assertDev();
    return { success: true, data: { probes: await this.cron.enqueueProbes(), redacted: await this.cron.redactBodies() } };
  }

  @Post('deliver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run one delivery attempt now as attempt N of M (exhaustion / circuit-breaker drills)' })
  async deliver(@Body() body: unknown) {
    this.assertDev();
    const { deliveryId, attempt, maxAttempts } = deliverBody.parse(body ?? {});
    try {
      await this.deliveryJobs.deliver({ deliveryId }, { jobId: 0n, attempt, maxAttempts });
      return { success: true, data: { outcome: 'done' as const } };
    } catch (err) {
      if (err instanceof JobSnoozeError) return { success: true, data: { outcome: 'snoozed' as const, delayMs: err.delayMs } };
      if (err instanceof JobDiscardError) return { success: true, data: { outcome: 'discarded' as const, message: err.message } };
      return { success: true, data: { outcome: 'retry' as const, message: (err as Error).message } };
    }
  }

  @Post('streak')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Age the failure streak of an endpoint (auto-disable and circuit-breaker drills)' })
  async streak(@Body() body: unknown) {
    this.assertDev();
    const { endpointId, failures, failingHours, lastFailureSecAgo } = streakBody.parse(body ?? {});
    const now = Date.now();
    await this.db.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        failures,
        failingSince: failures > 0 ? new Date(now - failingHours * 3_600_000) : null,
        lastFailureAt: lastFailureSecAgo === null ? null : new Date(now - lastFailureSecAgo * 1000),
      },
    });
    return { success: true };
  }
}
