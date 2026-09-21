// ============================================================
// core/idempotency (25-й) — заголовки, коды, лимиты, форма ключа.
// Общие для API, веба, mobile, сьютов и внешних интеграторов.
// ============================================================

/** Ключ повтора, который присылает клиент (имя Stripe — его понимают все интеграторы). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Ответ собран из сохранённого снимка, а не исполнен заново (`true`). */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * Подсказка клиенту: повторять этот запрос безопасно и осмысленно (`true`) либо
 * бессмысленно (`false`). Клиент не обязан знать таблицу статусов.
 */
export const SHOULD_RETRY_HEADER = 'X-Should-Retry';

/** Заголовки движка, которые браузер обязан ВИДЕТЬ на кросс-доменном ответе (CORS). */
export const IDEMPOTENCY_EXPOSED_HEADERS = [
  IDEMPOTENT_REPLAYED_HEADER,
  SHOULD_RETRY_HEADER,
  'Retry-After',
] as const;

/**
 * Форма ключа. 8–128 символов из безопасного набора: UUID, ULID, `order:42:v2`.
 * Длиннее не нужно (ключ — идентификатор намерения, а не тело), короче — коллизии
 * у клиентов со слабым генератором.
 */
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export const isIdempotencyKey = (v: unknown): v is string =>
  typeof v === 'string' && IDEMPOTENCY_KEY_RE.test(v);

export const IDEMPOTENCY_LIMITS = {
  /** Запись о ключе живёт столько дней (окно защиты от повтора) */
  keyTtlDays: 7,
  /**
   * Отпущенная заявка (`released` — эффекта не было) живёт столько часов. Она ничего
   * не защищает (перезахват ≡ новая заявка) и нужна только поддержке, а read-only
   * POST'ов с авто-ключом клиента — большинство: без короткого срока они и составляли
   * бы таблицу. Заявки принципала без аккаунта (гость, вебхук) удаляются сразу.
   */
  releasedTtlHours: 24,
  /** Снимок тела ответа живёт столько часов (окно реплея с телом) */
  responseTtlHours: 72,
  /** Аренда исполнения, мс: дольше — и упавший процесс держит ключ зря */
  leaseMs: 30_000,
  /** Продление аренды живым обработчиком, мс */
  heartbeatMs: 10_000,
  /** Потолок снимаемого тела, байт: больше — реплей отдаёт `already_completed` без тела */
  maxResponseBytes: 64 * 1024,
  /** `Retry-After` на `409 in_flight`, секунд */
  retryAfterSec: 1,
  /** Ящик входящих: строка живёт столько дней (> окна редоставки у всех источников) */
  inboxRetentionDays: 30,
  /**
   * Ящик входящих: аренда обработки, секунд. Событие отмечено, а обработчик молчит
   * дольше — значит процесс умер посреди работы, и редоставка вправе забрать событие.
   */
  inboxLeaseSec: 30,
  /** Чистка просроченных ключей: строк за один DELETE */
  sweepBatch: 5000,
  /** Партиций хэша у `idem.keys` (фиксировано схемой — менять только миграцией) */
  keyPartitions: 16,
} as const;

/** Состояние строки ключа. */
export const IDEMPOTENCY_STATES = ['in_progress', 'committed', 'completed', 'released'] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

/** Режим движка (`IDEMPOTENCY_MODE`). */
export const IDEMPOTENCY_MODES = ['off', 'observe', 'enforce'] as const;
export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

/**
 * Коды отказов. Значение — И ключ каталога `errors.*`, И `details.code`: клиент
 * ветвится по коду, фразу сервер рендерит в языке ЗАПРОСА (в том числе на реплее).
 */
export const IDEMPOTENCY_ERROR_CODES = {
  /** Необратимая операция без ключа (`required`) */
  keyRequired: 'idempotency.key_required',
  /** Ключ не той формы либо заголовок прислан дважды */
  keyInvalid: 'idempotency.key_invalid',
  /** Тот же ключ с ДРУГИМ телом — клиент перепутал намерения */
  keyReused: 'idempotency.key_reused',
  /** Первый запрос ещё исполняется */
  inFlight: 'idempotency.in_flight',
  /** Эффект случился, но тела ответа уже/ещё нет */
  alreadyCompleted: 'idempotency.already_completed',
  /** Прошлая попытка умерла на неизвестном месте — пере-исполнять небезопасно */
  outcomeUnknown: 'idempotency.outcome_unknown',
  /** Хранилище движка недоступно — на запросе с ключом защиты нет, значит отказ */
  unavailable: 'idempotency.unavailable',
} as const;

export type IdempotencyErrorCode =
  (typeof IDEMPOTENCY_ERROR_CODES)[keyof typeof IDEMPOTENCY_ERROR_CODES];

/**
 * Закрытый список причин `@SkipIdempotency(reason)`.
 *
 * ИНВАРИАНТ: причина обязана означать «повтор этого запроса безопасен». Клиент
 * авто-повторяет запрос, не зная, что маршрут исключён, — исключение по причине
 * «тут и так редко» сделало бы двойной эффект невидимым.
 */
export const IDEMPOTENCY_SKIP_REASONS = {
  /** Вход/выход/обновление токена: повтор безопасен, а ключ ломал бы ротацию */
  authFlow: 'auth_flow',
  /** Входящий вебхук: свой дедуп по идентификатору события источника (`inbox`) */
  inboundWebhook: 'inbound_webhook',
  /** Ответ — байты/стрим (`@Res()`, StreamableFile): снимать нечего */
  rawResponse: 'raw_response',
  /** У ручки СВОЙ механизм ровно-одного-раза (леджер, команды кабинета, uniqueKey джоба) */
  ownMechanism: 'own_mechanism',
  /** Операция естественно идемпотентна (PUT состояния, «прочитано», автосохранение) */
  naturallyIdempotent: 'naturally_idempotent',
  /** Побочных эффектов нет вовсе (поиск, предпросмотр, валидация) */
  noSideEffects: 'no_side_effects',
} as const;

export type IdempotencySkipReason =
  (typeof IDEMPOTENCY_SKIP_REASONS)[keyof typeof IDEMPOTENCY_SKIP_REASONS];

export const IDEMPOTENCY_SKIP_REASON_VALUES: readonly string[] = Object.values(IDEMPOTENCY_SKIP_REASONS);

/** Производный ключ вниз по стеку (леджер, джобы, PSP) — см. `deriveKey`. */
export const IDEMPOTENCY_DERIVED_PREFIX = 'idem:v1:';
/** Ключ, собранный из стабильных частей ВНЕ HTTP (джоб, крон, нода процесса). */
export const IDEMPOTENCY_STABLE_PREFIX = 'idem:s1:';
