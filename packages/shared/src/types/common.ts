// ---- Конверт ответа API: ФОРМА ПРОВОДА, а не пожелание ----
// Успех кладут контроллеры (`{ success: true, data }`), отказ — единый
// `AllExceptionsFilter` (Zod → 400 с полями, HttpException, Prisma P2002/P2025, 500).
// Распаковывают конверт хелперы транспорта (`@superapp/api-client`) — больше нигде
// `.data.data` в клиентах быть не должно.
export interface ApiOk<T> {
  success: true;
  data: T;
}

/** Поле `errors`: Zod отдаёт `{path, message}`, сервис может бросить свой список. */
export interface ApiErrorItem {
  path?: string;
  message: string;
}

export interface ApiError {
  success: false;
  statusCode: number;
  message: string;
  errors?: ApiErrorItem[];
  /** Машиночитаемые детали отказа (первый потребитель — core/verify: code/resendInSec/attemptsLeft). */
  details?: Record<string, unknown>;
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
