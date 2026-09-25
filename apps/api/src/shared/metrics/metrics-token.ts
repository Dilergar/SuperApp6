import { timingSafeEqual } from 'node:crypto';
import { isProdEnv } from '../config/env.validation';

/**
 * Допуск к служебной наблюдаемости (`/metrics`, детали `/health/ready`): `METRICS_TOKEN` в
 * `Authorization: Bearer …`, сверка в константное время. Токен не задан → в production
 * закрыто (fail-closed: метрики раскрывают объёмы, имена очередей и состояние инфраструктуры),
 * в разработке — открыто для локального скрейпа.
 */
export function metricsAccessGranted(authorization: string | undefined): boolean {
  const token = process.env.METRICS_TOKEN || null;
  if (!token) return !isProdEnv();
  const got = /^Bearer\s+(.+)$/i.exec((authorization ?? '').trim())?.[1]?.trim() ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
