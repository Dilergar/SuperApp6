import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/**
 * Maps Zod validation failures (thrown by `schema.parse()` in controllers) to a
 * clean 400 with the first human-readable message + the full issue list, instead
 * of leaking a generic 500. Applies app-wide.
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
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
  }
}
