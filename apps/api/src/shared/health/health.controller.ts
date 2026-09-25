import { Controller, Get, Headers, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { metricsAccessGranted } from '../metrics/metrics-token';
import { HealthService } from './health.service';

/**
 * Пробы балансировщика и оркестратора — у корня, вне `/api` (как `/metrics`):
 *   `GET /health/live`  — процесс жив (без зависимостей: иначе падение базы перезапустило бы
 *                          все поды разом и добавило холодный старт к аварии);
 *   `GET /health/ready` — инстанс готов принимать трафик: 200 `ok`/`degraded`, 503 `unavailable`.
 * Снаружи — только итог; разбивка по проверкам — держателю METRICS_TOKEN (состояние
 * инфраструктуры — разведданные). Без троттлинга: пробы идут с адресов балансировщика.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('live')
  live(@Res() res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok' });
  }

  @Public()
  @Get('ready')
  async ready(@Headers('authorization') authorization: string | undefined, @Res() res: Response): Promise<void> {
    const report = await this.health.ready();
    res.setHeader('Cache-Control', 'no-store');
    res.status(report.status === 'unavailable' ? 503 : 200).json(metricsAccessGranted(authorization) ? report : { status: report.status });
  }
}
