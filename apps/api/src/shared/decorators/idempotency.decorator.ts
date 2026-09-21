import { SetMetadata } from '@nestjs/common';
import type { IdempotencySkipReason } from '@superapp/shared';

// ============================================================
// core/idempotency — объявление ручки.
//
// По умолчанию движок покрывает ВСЕ мутации: ключ необязателен, но если клиент его
// прислал — повтор безопасен. Декораторы нужны там, где умолчание неверно.
// ============================================================

export const IDEMPOTENT_KEY = 'idempotency:options';
export const SKIP_IDEMPOTENCY_KEY = 'idempotency:skip';

/** Кто делает запрос на `@Public`-ручке (гость, вебхук-триггер): стабильная строка либо `null`. */
export type IdempotencyPrincipalResolver = (req: {
  headers?: Record<string, unknown>;
  body?: unknown;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}) => string | null;

export interface IdempotentOptions {
  /**
   * Ключ ОБЯЗАТЕЛЕН (необратимая операция): без него — `400 idempotency.key_required`.
   * На `@Public`-ручке требует `principal` — иначе бут падает (страж маршрутов).
   */
  required?: boolean;
  /**
   * Обещание ручки: ровно ОДНА транзакция и никаких эффектов мимо неё. Тогда
   * оборванную попытку безопасно пере-исполнить, и `409 outcome_unknown` не нужен.
   * Проверяется на КАЖДОМ успехе; нарушение — метрика, в dev — 500.
   */
  atomic?: boolean;
  /**
   * `none` — тела не хранить вовсе (ответ несёт секрет: ключ API, токен звонка,
   * подписанный URL). Повтор получит `409 already_completed` вместо секрета.
   */
  store?: 'auto' | 'none';
  /**
   * `external` — эффект ручки живёт ТОЛЬКО вне базы (звонок наружу, списание у PSP).
   * Привязка к транзакции его не видит, поэтому успех становится финальным всегда.
   */
  effects?: 'db' | 'external';
  /** Аренда исполнения, мс (долгая ручка). По умолчанию — `IDEMPOTENCY_LIMITS.leaseMs`. */
  leaseMs?: number;
  /** Принципал для `@Public`-ручек. Вернул `null` — запрос идёт мимо движка. */
  principal?: IdempotencyPrincipalResolver;
  /**
   * Имя шлюза повторной авторизации (`IdempotencyReplayRegistry.registerGate`).
   * ОБЯЗАТЕЛЬНО вместе с `principal`: у `@Public`-ручки гардов нет, её авторизация
   * живёт в обработчике, а повтор обработчик не зовёт — без шлюза отозванная ссылка
   * продолжала бы отдавать сохранённый ответ. Страж маршрутов роняет бут, если имя
   * не названо либо под ним никто не зарегистрировался.
   */
  gate?: string;
}

/** Уточнить поведение движка на этой ручке (или на всём контроллере). */
export const Idempotent = (options: IdempotentOptions = {}) => SetMetadata(IDEMPOTENT_KEY, options);

/**
 * Вывести маршрут из-под движка. Причина — из ЗАКРЫТОГО списка, и она обязана
 * означать «повтор этого запроса безопасен»: клиент авто-повторяет запрос, не зная,
 * что маршрут исключён. Неизвестная причина — бут падает.
 */
export const SkipIdempotency = (reason: IdempotencySkipReason) => SetMetadata(SKIP_IDEMPOTENCY_KEY, reason);
