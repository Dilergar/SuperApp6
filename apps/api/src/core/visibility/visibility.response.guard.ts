import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import {
  VISIBILITY_CLASS_RANK,
  VISIBILITY_ERROR_CODES,
  VISIBILITY_TYPE_KEYS,
  isGuardMarker,
  isVisibilityFieldConfigurable,
  visibilityFieldsOf,
} from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { VISIBILITY_EXEMPT_KEY } from '../../shared/decorators/visibility.decorator';
import { ApiError, forbidden } from '../../shared/errors/api-error';
import { HttpStatus } from '@nestjs/common';
import { VisibilityMetrics } from './visibility.metrics';
import { isShaped } from './visibility.service';

/** Подпись типа: ключи его настраиваемых полей класса ≥ contact (то, что правило может скрыть). */
interface Signature {
  type: string;
  keys: ReadonlySet<string>;
}

const SIGNATURES: Signature[] = VISIBILITY_TYPE_KEYS.map((type) => ({
  type,
  keys: new Set(
    visibilityFieldsOf(type)
      .filter((e) => isVisibilityFieldConfigurable(type, e.key) && VISIBILITY_CLASS_RANK[e.def.class] >= VISIBILITY_CLASS_RANK.contact)
      .map((e) => e.key),
  ),
})).filter((s) => s.keys.size >= 2);

const MAX_DEPTH = 8;
const MAX_ARRAY_SAMPLE = 50;

/** Первый объект ответа, несущий ≥ 2 «сырых» защищённых ключа одного типа без бренда `shape()`. */
export function findUnshaped(body: unknown, depth = 0): { type: string; keys: string[] } | null {
  if (!body || typeof body !== 'object' || depth > MAX_DEPTH) return null;
  if (Array.isArray(body)) {
    for (const item of body.slice(0, MAX_ARRAY_SAMPLE)) {
      const hit = findUnshaped(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (body instanceof Date || Buffer.isBuffer(body)) return null;
  const obj = body as Record<string, unknown>;
  if (!isShaped(obj)) {
    for (const sig of SIGNATURES) {
      const raw: string[] = [];
      for (const k of Object.keys(obj)) {
        if (!sig.keys.has(k)) continue;
        const v = obj[k];
        if (v === null || v === undefined || isGuardMarker(v)) continue;
        raw.push(k);
      }
      if (raw.length >= 2) return { type: sig.type, keys: raw };
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !isGuardMarker(v)) {
      const hit = findUnshaped(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Страж ответа (чокпойнт P, «план обязателен» — урок Salesforce `SECURITY_ENFORCED`, который
 * включают руками): объект с ≥ 2 «сырыми» защищёнными ключами одного типа, не прошедший
 * `shape()` (нет бренда), — в development/test `500 visibility.unshaped_response` (громко для
 * разработчика), в production — отказ `403` с тем же кодом (он же свёртка `authz.denied`) и
 * метрика. Исключения — только `@VisibilityExempt(причина из закрытого списка)` и Кабинет
 * платформы (свои маски). `@Res()`-маршруты (ZIP) вне интерцептора — их держит канареечный сьют.
 */
@Injectable()
export class VisibilityResponseGuard implements NestInterceptor {
  private readonly logger = new Logger(VisibilityResponseGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly metrics: VisibilityMetrics,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const exempt = this.reflector.getAllAndOverride<string>(VISIBILITY_EXEMPT_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (exempt) return next.handle();
    const req = ctx.switchToHttp().getRequest<{ originalUrl?: string; url?: string; route?: { path?: string } }>();
    const url = req.originalUrl ?? req.url ?? '';
    // Кабинет платформы: свои маски (общая функция из shared) и своё раскрытие командой с журналом
    if (/^\/api(\/v\d+)?\/platform(\/|$)/.test(url)) return next.handle();
    return next.handle().pipe(
      map((body) => {
        const hit = findUnshaped(body);
        if (!hit) return body;
        this.metrics.unshaped.inc({ record_type: hit.type });
        const route = typeof req.route?.path === 'string' ? req.route.path : url.split('?')[0];
        this.logger.error(`unshaped response: ${route} returns ${hit.type} fields [${hit.keys.join(', ')}] without shape()`);
        if (isDevEnv()) {
          throw new ApiError(HttpStatus.INTERNAL_SERVER_ERROR, { code: VISIBILITY_ERROR_CODES.unshapedResponse, details: { code: VISIBILITY_ERROR_CODES.unshapedResponse, recordType: hit.type } });
        }
        throw forbidden(VISIBILITY_ERROR_CODES.unshapedResponse, undefined, { code: VISIBILITY_ERROR_CODES.unshapedResponse });
      }),
    );
  }
}
