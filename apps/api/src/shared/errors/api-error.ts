import { HttpException, HttpStatus } from '@nestjs/common';

// ============================================================
// ApiError — отказ, который НЕ несёт текста.
//
// Сервис называет ПРИЧИНУ машинным кодом (`workspace.noAccess`), а слова
// подбирает AllExceptionsFilter в языке запроса из каталога `errors`. Модель
// Stripe / Google APIs: `details.code` есть ВСЕГДА, клиент ветвится по нему и
// никогда — по человеческому тексту.
//
// Прежние `new ForbiddenException('русский текст')` продолжают работать как
// есть: фильтр отдаёт их текст без перевода. Вытесняет их не запрет, а ратчет
// (`i18n.legacy.json` + `pnpm check:i18n`) — файл за файлом.
// ============================================================

/** Значения для подстановки в текст отказа (ICU). Только примитивы. */
export type ErrorParams = Record<string, string | number | boolean>;

export interface ApiErrorBody {
  /** Ключ каталога БЕЗ префикса `errors.` — он же `details.code` в конверте */
  code: string;
  params?: ErrorParams;
  /**
   * Дополнительные машиночитаемые детали — уезжают в `details` рядом с кодом
   * (первый потребитель: `resendInSec` / `attemptsLeft` для таймеров UI).
   */
  details?: Record<string, unknown>;
}

export class ApiError extends HttpException {
  readonly code: string;
  readonly params?: ErrorParams;
  readonly extra?: Record<string, unknown>;

  constructor(status: HttpStatus, body: ApiErrorBody) {
    // Тело исключения несёт код, а не фразу: `message` в него кладёт фильтр,
    // когда узнаёт язык запроса. Здесь языка ещё нет — исключение может быть
    // брошено в джобе, в сокете, до интерцептора.
    super({ code: body.code, params: body.params, details: body.details }, status);
    this.code = body.code;
    this.params = body.params;
    this.extra = body.details;
  }
}

const make =
  (status: HttpStatus) =>
  (code: string, params?: ErrorParams, details?: Record<string, unknown>): ApiError =>
    new ApiError(status, { code, params, details });

/** 400 — запрос не годится (форма, состояние, аргументы). */
export const badRequest = make(HttpStatus.BAD_REQUEST);
/** 401 — не представился (гость там, где нужен аккаунт). */
export const unauthorized = make(HttpStatus.UNAUTHORIZED);
/** 403 — представился, но права не хватает. */
export const forbidden = make(HttpStatus.FORBIDDEN);
/** 404 — нет такого объекта ЛИБО он скрыт правами (fail-closed). */
export const notFound = make(HttpStatus.NOT_FOUND);
/** 409 — конкурентное изменение, дубль, недопустимый переход состояния. */
export const conflict = make(HttpStatus.CONFLICT);
/** 429 — превышен темп; `details.resendInSec` уедет в заголовок Retry-After. */
export const tooMany = make(HttpStatus.TOO_MANY_REQUESTS);
/** 422 — форма разобрана, но смысл недопустим. */
export const unprocessable = make(HttpStatus.UNPROCESSABLE_ENTITY);
/**
 * 402 — отказ ТАРИФА (core/entitlements): фича не включена, лимит достигнут, квота
 * исчерпана. Отдельный статус, чтобы клиент отличал «нельзя по правам» (403) от
 * «нельзя по тарифу» и рисовал замок с объяснением; `details` несёт `code`
 * (`entitlement.<reason>`), `key`, `value`, `used`, `contextType`, `unlock`.
 */
export const paymentRequired = make(HttpStatus.PAYMENT_REQUIRED);

/** Это наш типизированный отказ (а не голый HttpException из прошлой эпохи)? */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
