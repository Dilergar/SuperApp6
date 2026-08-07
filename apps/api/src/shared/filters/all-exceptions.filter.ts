import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@superapp/shared';

/**
 * The ONE error envelope for the whole API (arch-review block 7): every failure —
 * Zod validation, HttpException, Prisma known errors, unknown crashes — is serialized
 * as `{ success: false, statusCode, message, errors? }`. Before this filter, clients
 * had to parse three different shapes (Zod filter / Nest default / bare 500), which a
 * mobile client can't do reliably.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception; // WS/RPC contexts keep their own handling

    const res = host.switchToHttp().getResponse<Response>();

    // 1) Zod validation (schema.parse in controllers) → 400 + per-field issues.
    if (exception instanceof ZodError) {
      const issues = exception.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      // Тип на литерале: конверт отказа — такая же ФОРМА ПРОВОДА, как успешный
      // ответ, и клиенты (`apiErrorMessage`, ветвление по `details.code`) читают
      // именно её. Раньше её описывал только этот файл.
      const body: ApiError = {
        success: false,
        statusCode: HttpStatus.BAD_REQUEST,
        message: issues[0]?.message ?? 'Ошибка валидации',
        errors: issues,
      };
      res.status(HttpStatus.BAD_REQUEST).json(body);
      return;
    }

    // 2) HttpException (Forbidden/NotFound/BadRequest/... thrown by services/guards).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Nest's body is either a string or { message: string | string[], ... }.
      const raw = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      const message = Array.isArray(raw) ? raw[0] ?? exception.message : raw ?? exception.message;
      // Опциональные машиночитаемые детали: сервис бросает
      // `new HttpException({ message, details: {...} }, status)` — details уходят в конверт
      // как есть (первый потребитель — core/verify: resendInSec / attemptsLeft для таймеров UI).
      const details =
        typeof body === 'object' && body !== null && 'details' in body
          ? (body as { details?: Record<string, unknown> }).details
          : undefined;
      // Стандартный Retry-After на 429: его понимают браузеры, http-клиенты и боты,
      // и он бесплатно достаётся всем, кто уже кладёт resendInSec в details.
      const retryAfter = details?.resendInSec;
      if (status === 429 && typeof retryAfter === 'number' && retryAfter > 0) {
        res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
      }
      // Явный errors из тела исключения: сервис бросает
      // `new BadRequestException({ message, errors: [{field, message}] })`. Раньше конверт
      // его терял (пробрасывался только случай, когда массивом был сам message), и клиент
      // получал «Процесс не готов к публикации» / «Проверьте анкету процесса» БЕЗ указания,
      // что именно не так — в том числе для отказов по правам.
      const explicitErrors =
        typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors)
          ? (body as { errors: unknown[] }).errors
          : undefined;
      res.status(status).json({
        success: false,
        statusCode: status,
        message,
        ...(details ? { details } : {}),
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
          message: 'Конфликт данных: такая запись уже существует',
        });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(HttpStatus.NOT_FOUND).json({
          success: false,
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Запись не найдена',
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
      message: 'Внутренняя ошибка сервера',
    });
  }
}
