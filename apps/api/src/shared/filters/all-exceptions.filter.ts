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
      res.status(HttpStatus.BAD_REQUEST).json({
        success: false,
        statusCode: HttpStatus.BAD_REQUEST,
        message: issues[0]?.message ?? 'Ошибка валидации',
        errors: issues,
      });
      return;
    }

    // 2) HttpException (Forbidden/NotFound/BadRequest/... thrown by services/guards).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Nest's body is either a string or { message: string | string[], ... }.
      const raw = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      const message = Array.isArray(raw) ? raw[0] ?? exception.message : raw ?? exception.message;
      res.status(status).json({
        success: false,
        statusCode: status,
        message,
        ...(Array.isArray(raw) && raw.length > 1 ? { errors: raw.map((m) => ({ message: m })) } : {}),
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
