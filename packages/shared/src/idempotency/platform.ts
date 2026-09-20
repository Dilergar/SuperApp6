import { z } from 'zod';
import { IDEMPOTENCY_KEY_RE, type IdempotencyState } from './constants';

// ============================================================
// Кабинет платформы (core/platform) × движок идемпотентности.
//
// Правило раздела: тела ответов кабинет НЕ раскрывает НИКОГДА — ни командой, ни
// панелью. Снимок лежит под KEK владельца, и поддержке он не нужен: спор решают
// факты «сколько раз приходил, чем кончилось», а не содержимое.
// ============================================================

/** Поиск по ключу повтора — для разбора с интегратором («мой запрос прошёл?»). */
export const idempotencyKeyLookupInputSchema = z
  .object({
    /** Сырой ключ, как его слал клиент; сервер хэширует и ищет по хэшу */
    key: z.string().regex(IDEMPOTENCY_KEY_RE, 'idempotency.key_invalid'),
  })
  .strict();
export type IdempotencyKeyLookupInput = z.infer<typeof idempotencyKeyLookupInputSchema>;

/** Одна найденная заявка. Ни ключа, ни тела, ни отпечатка — только факты. */
export interface IdempotencyKeyHitDto {
  method: string;
  route: string;
  principal: string;
  userId: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  state: IdempotencyState;
  attempt: number;
  replays: number;
  httpStatus: number | null;
  errorCode: string | null;
  resourceId: string | null;
  build: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Есть ли сохранённое тело (само тело не отдаётся никогда) */
  hasBody: boolean;
}

export interface IdempotencyKeyLookupDto {
  hits: IdempotencyKeyHitDto[];
}

/** Панель карточки 360: «спорные операции» человека за окно. */
export interface IdempotencyPersonPanelDto {
  windowDays: number;
  /** Всего заявок за окно */
  total: number;
  /** Клиент приходил повторно (replays > 0) */
  repeated: number;
  /** Исход остался неизвестным (брошенная попытка) */
  unresolved: number;
  /** Эффект закоммичен, ответ собрать не успели */
  committedWithoutAnswer: number;
  /** Ключ отпущен: эффекта не было */
  released: number;
  lastAt: string | null;
}
