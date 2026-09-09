import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ZodError, type ZodIssue } from 'zod';
import { LOCALE_HEADER, type ApiError as ApiErrorEnvelope } from '@superapp/shared';
import { countryFromHeaders, negotiateLocale, type Locale } from '@superapp/i18n';
import { I18nService } from '../i18n/i18n.service';
import { ApiError } from '../errors/api-error';

/**
 * The ONE error envelope for the whole API (arch-review block 7): every failure —
 * Zod validation, HttpException, Prisma known errors, unknown crashes — is serialized
 * as `{ success: false, statusCode, message, details?, errors? }`. Before this filter,
 * clients had to parse three different shapes (Zod filter / Nest default / bare 500),
 * which a mobile client can't do reliably.
 *
 * МУЛЬТИЯЗЫЧНОСТЬ. `message` — текст ДЛЯ ЧЕЛОВЕКА и рендерится в языке запроса;
 * `details.code` — машинный код, он есть ВСЕГДА и не зависит от языка (модель
 * Stripe/Google APIs). Клиент ветвится по коду, показывает `message`.
 *
 * Язык берётся ИЗ ЗАГОЛОВКА запроса, а не из ALS: отказы гардов (throttler, JWT,
 * roles) случаются ДО WorkspaceContextInterceptor, и в ALS языка ещё нет — а
 * отвечать по-казахски человеку, который просит по-русски, нельзя именно в тот
 * момент, когда что-то сломалось.
 *
 * Наследие: `new ForbiddenException('русский текст')` продолжает работать — его
 * текст уезжает как есть, а `details.code` подставляется по HTTP-статусу. Вытесняет
 * такие места ратчет (`i18n.legacy.json` + `pnpm check:i18n`), а не запрет.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception; // WS/RPC contexts keep their own handling

    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const locale = this.localeOf(http.getRequest<Request>());
    const t = (key: string, params?: Record<string, string | number | boolean>) =>
      this.i18n.translateFor(locale, key, params);

    // 1) Zod validation (schema.parse in controllers) → 400 + per-field issues.
    if (exception instanceof ZodError) {
      const issues = exception.issues.map((i) => ({
        path: i.path.join('.'),
        code: `validation.${i.code}`,
        message: this.zodMessage(i, locale),
      }));
      // Тип на литерале: конверт отказа — такая же ФОРМА ПРОВОДА, как успешный
      // ответ, и клиенты (`apiErrorMessage`, ветвление по `details.code`) читают
      // именно её. Раньше её описывал только этот файл.
      const body: ApiErrorEnvelope = {
        success: false,
        statusCode: HttpStatus.BAD_REQUEST,
        message: issues[0]?.message ?? t('errors.validation.failed'),
        errors: issues,
        details: { code: 'validation.failed' },
      };
      res.status(HttpStatus.BAD_REQUEST).json(body);
      return;
    }

    // 2) HttpException (Forbidden/NotFound/BadRequest/... thrown by services/guards).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const asObject = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;

      // 2a) Наш типизированный отказ: текста нет вовсе — только код и параметры.
      if (exception instanceof ApiError) {
        const details = {
          code: exception.code,
          ...(exception.params ? { params: exception.params } : {}),
          ...(exception.extra ?? {}),
        };
        this.setRetryAfter(res, status, details);
        res.status(status).json({
          success: false,
          statusCode: status,
          message: t(`errors.${exception.code}`, exception.params),
          details,
        });
        return;
      }

      // 2b) Наследие: Nest's body is either a string or { message: string | string[], ... }.
      const raw = typeof body === 'string' ? body : (asObject?.message as string | string[] | undefined);
      const message = Array.isArray(raw) ? raw[0] ?? exception.message : raw ?? exception.message;
      // Опциональные машиночитаемые детали: сервис бросает
      // `new HttpException({ message, details: {...} }, status)` — details уходят в конверт
      // как есть (первый потребитель — core/verify: resendInSec / attemptsLeft для таймеров UI).
      const rawDetails = (asObject?.details as Record<string, unknown> | undefined) ?? undefined;
      // `details.code` обязателен ВСЕГДА (правило конверта): если сервис его не
      // назвал, подставляем код статуса — клиент всё равно получает машинную ветку.
      const details: Record<string, unknown> = {
        code: rawDetails?.code ?? statusCode(status),
        ...(rawDetails ?? {}),
      };
      this.setRetryAfter(res, status, details);
      // Явный errors из тела исключения: сервис бросает
      // `new BadRequestException({ message, errors: [{field, message}] })`. Раньше конверт
      // его терял (пробрасывался только случай, когда массивом был сам message), и клиент
      // получал «Процесс не готов к публикации» / «Проверьте анкету процесса» БЕЗ указания,
      // что именно не так — в том числе для отказов по правам.
      const explicitErrors = Array.isArray(asObject?.errors) ? (asObject!.errors as unknown[]) : undefined;
      res.status(status).json({
        success: false,
        statusCode: status,
        message,
        details,
        ...(explicitErrors
          ? { errors: explicitErrors }
          : Array.isArray(raw) && raw.length > 1
            ? { errors: raw.map((m) => ({ message: m })) }
            : {}),
      });
      return;
    }

    // 3) Prisma known errors that have a sane HTTP meaning.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        res.status(HttpStatus.CONFLICT).json({
          success: false,
          statusCode: HttpStatus.CONFLICT,
          message: t('errors.db.uniqueViolation'),
          details: { code: 'db.uniqueViolation' },
        });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(HttpStatus.NOT_FOUND).json({
          success: false,
          statusCode: HttpStatus.NOT_FOUND,
          message: t('errors.db.notFound'),
          details: { code: 'db.notFound' },
        });
        return;
      }
      if (exception.code === 'P2003') {
        // Нарушение внешнего ключа — это НЕ «внутренняя ошибка»: клиент сослался
        // на несуществующую строку. 400 с кодом, а не 500 с «что-то сломалось».
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          statusCode: HttpStatus.BAD_REQUEST,
          message: t('errors.db.relationMissing'),
          details: { code: 'db.relationMissing' },
        });
        return;
      }
    }

    // 4) Everything else → 500, logged loudly with the stack (the client gets no internals).
    this.logger.error(
      `Unhandled exception: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: t('errors.internal'),
      details: { code: 'internal' },
    });
  }

  /**
   * Стандартный Retry-After на 429: его понимают браузеры, http-клиенты и боты,
   * и он бесплатно достаётся всем, кто уже кладёт resendInSec в details.
   */
  private setRetryAfter(res: Response, status: number, details: Record<string, unknown>): void {
    const retryAfter = details.resendInSec ?? details.retryInSec;
    if (status === 429 && typeof retryAfter === 'number' && retryAfter > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
    }
  }

  private localeOf(req: Request | undefined): Locale {
    const first = (name: string): string | undefined => {
      const raw = req?.headers?.[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    return negotiateLocale(first('accept-language'), first(LOCALE_HEADER.toLowerCase()), {
      country: countryFromHeaders(first),
    });
  }

  /**
   * Проблема Zod → фраза каталога. Ключи `errors.validation.*`; путь поля и
   * границы уезжают параметрами, поэтому фраза остаётся одной строкой на язык.
   *
   * Кастомные сообщения схем (`.refine(fn, 'Недопустимые символы')`) каталог
   * пока не покрывает — они отдаются как есть (то же наследие, что и голые
   * исключения). Их вытесняет ратчет по мере перевода схем.
   */
  private zodMessage(issue: ZodIssue, locale: Locale): string {
    const t = (key: string, params?: Record<string, string | number | boolean>) =>
      this.i18n.translateFor(locale, key, params);
    const path = issue.path.join('.') || '—';

    // Схема может назвать КЛЮЧ каталога вместо фразы:
    //   z.string().min(1, 'validation.calendar.title')
    // Тогда её сообщение точнее общей фразы И переводится. Проверка идёт первой
    // и для ЛЮБОГО кода проблемы: `min(1, …)` — это `too_small`, а не `custom`,
    // и без неё своё сообщение схемы терялось бы под общей формулировкой.
    const own = issue.message;
    if (own && this.i18n.has(`errors.${own}`, locale)) return t(`errors.${own}`);

    switch (issue.code) {
      case 'invalid_type':
        return issue.received === 'undefined'
          ? t('errors.validation.required', { path })
          : t('errors.validation.invalidType', {
              path,
              expected: String(issue.expected),
              received: String(issue.received),
            });
      case 'too_small': {
        const kind = pickSizeKind(issue.type);
        return t(`errors.validation.tooSmall.${kind}`, { path, minimum: Number(issue.minimum) });
      }
      case 'too_big': {
        const kind = pickSizeKind(issue.type);
        return t(`errors.validation.tooBig.${kind}`, { path, maximum: Number(issue.maximum) });
      }
      case 'invalid_string': {
        const v = typeof issue.validation === 'string' ? issue.validation : 'other';
        const known = ['email', 'url', 'uuid', 'datetime'].includes(v) ? v : 'other';
        return t(`errors.validation.invalidString.${known}`, { path });
      }
      case 'invalid_enum_value':
        return t('errors.validation.invalidEnum', { path });
      case 'invalid_date':
        return t('errors.validation.invalidDate', { path });
      case 'unrecognized_keys':
        return t('errors.validation.unrecognizedKeys', { keys: issue.keys.join(', ') });
      case 'not_multiple_of':
        return t('errors.validation.notMultipleOf', { path, multipleOf: Number(issue.multipleOf) });
      case 'not_finite':
        return t('errors.validation.notFinite', { path });
      default:
        // `custom` и составные (union / intersection): у схемы часто есть своё
        // сообщение — оно точнее общей фразы. Нет своего → общая.
        return issue.message && issue.message !== 'Invalid input'
          ? issue.message
          : t('errors.validation.custom', { path });
    }
  }
}

/** Размерная проблема Zod знает свой тип — ветка каталога совпадает с ним. */
function pickSizeKind(type: string): 'string' | 'number' | 'array' | 'date' | 'other' {
  if (type === 'string' || type === 'number' || type === 'array' || type === 'date') return type;
  return 'other';
}

/** HTTP-статус → машинный код по умолчанию для наследных исключений. */
function statusCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'http.badRequest';
    case HttpStatus.UNAUTHORIZED:
      return 'http.unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'http.forbidden';
    case HttpStatus.NOT_FOUND:
      return 'http.notFound';
    case HttpStatus.CONFLICT:
      return 'http.conflict';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'http.payloadTooLarge';
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return 'http.unsupportedMedia';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'http.tooManyRequests';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'unavailable';
    default:
      return status >= 500 ? 'internal' : 'http.badRequest';
  }
}
