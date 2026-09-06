// ---- Конверт ответа API: ФОРМА ПРОВОДА, а не пожелание ----
// Успех кладут контроллеры (`{ success: true, data }`), отказ — единый
// `AllExceptionsFilter` (Zod → 400 с полями, HttpException, Prisma P2002/P2025, 500).
// Распаковывают конверт хелперы транспорта (`@superapp/api-client`) — больше нигде
// `.data.data` в клиентах быть не должно.
export interface ApiOk<T> {
  success: true;
  data: T;
}

/** Поле `errors`: Zod отдаёт `{path, message, code}`, сервис может бросить свой список. */
export interface ApiErrorItem {
  path?: string;
  message: string;
  /** Машинный код проблемы поля (`validation.too_small`) — клиент не ветвится по тексту. */
  code?: string;
}

/**
 * Машиночитаемые детали отказа. `code` ОБЯЗАТЕЛЕН (модель Stripe/Google APIs):
 * `message` — текст для человека в языке запроса и может измениться вместе с
 * переводом, `code` вечен, и именно по нему клиент ветвит поведение.
 */
export interface ApiErrorDetails {
  code: string;
  /** Параметры подстановки текста (клиент может собрать свою фразу) */
  params?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export interface ApiError {
  success: false;
  statusCode: number;
  /** Уже переведён сервером в языке запроса (`Accept-Language`). */
  message: string;
  errors?: ApiErrorItem[];
  details?: ApiErrorDetails;
}

/**
 * Полный конверт провода. Хелперы транспорта видят только `ApiOk` (отказ прилетает
 * брошенной axios-ошибкой, её тело — `ApiError`); union нужен там, где ответ
 * разбирается целиком (например, `apiGetRaw` по нестандартному конверту).
 */
export type ApiResponse<T = unknown> = ApiOk<T> | ApiError;

// ---- Страницы: ДВЕ формы на всю платформу ----
// Раньше каждая ручка описывала свою (самописные `{items, nextCursor}` в shared +
// 8 рукописей на вебе), потому что контроллеры расплющивали страницу сервиса на
// `data` + соседнее поле. Теперь страница едет в `data` цельной, обе стороны провода
// стоят на одном типе, а страничные DTO выражаются ЧЕРЕЗ эти формы: точная страница —
// алиас `CursorPage<T>`, страница с довеском (actors и т.п.) — `extends CursorPage<T>`.

/** Курсорная страница — основная модель платформы. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Постраничная выдача (page/limit) — сегодня только `GET /tasks`. */
export interface OffsetPage<T> {
  items: T[];
  meta: PageMeta;
}
