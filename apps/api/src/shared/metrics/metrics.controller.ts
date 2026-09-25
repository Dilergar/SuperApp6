import { Controller, Get, Headers, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { notFound } from '../errors/api-error';
import { metricsAccessGranted } from './metrics-token';
import { MetricsService } from './metrics.service';

/**
 * `GET /metrics` (вне `/api`, стандартный адрес Prometheus). Гейт — `METRICS_TOKEN`
 * в заголовке `Authorization: Bearer …`: задан → сверяется в константное время;
 * не задан → в production маршрут отвечает 404 (fail-closed: метрики раскрывают
 * объёмы и имена очередей), в development — открыт для локального скрейпа.
 * Значения метрик не несут ПДн и идентификаторов (только коды и счётчики).
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  async scrape(@Headers('authorization') authorization: string | undefined, @Res() res: Response): Promise<void> {
    if (!metricsAccessGranted(authorization)) throw notFound('http.notFound');
    res.setHeader('Content-Type', this.metrics.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(await this.metrics.render());
  }
}
