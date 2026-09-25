import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from './metrics.service';

/**
 * Гистограмма длительности HTTP (`http_request_duration_seconds`): метка маршрута — ШАБЛОН
 * (`/api/tasks/:id`), не адрес: id в метке = бесконечная кардинальность и утечка
 * идентификаторов в метрики. Запрос мимо маршрутов — `unmatched`; статус — классом (`2xx`…).
 */
export function httpMetricsMiddleware(metrics: MetricsService) {
  const hist = metrics.histogram(
    'http_request_duration_seconds',
    'HTTP request duration by route template',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ['method', 'route', 'status'],
  );
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const tpl = (req.route as { path?: unknown } | undefined)?.path;
      const route = typeof tpl === 'string' ? `${req.baseUrl ?? ''}${tpl}` : 'unmatched';
      hist.observe({ method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` }, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  };
}
