-- ============================================================
-- core/idempotency (25-й движок) — идемпотентность повторов
-- ============================================================
-- Раскладка та же, что у аналитики: СЛУЖЕБНОЕ хранилище живёт в своей схеме `idem`
-- (Prisma сравнивает только `public` и партиций не видит), в `public` — единственная
-- Prisma-модель «входящего ящика».
--
-- Дописано руками (Prisma не выражает): схема `idem`, HASH-партиции `idem.keys`,
-- RANGE-партиции по дню `idem.responses`, fillfactor и настройки автовакуума.
--
-- ПОЧЕМУ HASH, а не RANGE по времени: уникальность ключа обязана быть ГЛОБАЛЬНОЙ.
-- На RANGE-партициях по дню уникальный индекс обязан включать колонку разбиения,
-- и один и тот же ключ, пришедший до и после полуночи, попал бы в РАЗНЫЕ партиции —
-- то есть продублировал бы эффект. HASH по (scope_hash, key_hash) кладёт обе попытки
-- в одну партицию всегда, и уникальность держит индекс, а не протокол.
--
-- ЛОВУШКА PG 16: storage-параметры (fillfactor, автовакуум) и identity-колонки на
-- САМОЙ партиционированной таблице не поддерживаются — первое ставится на листья,
-- второе заменено явной последовательностью с DEFAULT (приём `api_access_log`).

CREATE SCHEMA IF NOT EXISTS idem;

-- ---------- idem.keys: заявка на исполнение (правда о ключе) ----------
CREATE TABLE idem.keys (
  -- sha256(sub | keyId|'session' | activeWorkspaceId | METHOD | шаблон маршрута)
  "scope_hash"    BYTEA        NOT NULL,
  -- sha256(сырой ключ клиента); сам ключ не хранится и не логируется
  "key_hash"      BYTEA        NOT NULL,
  -- Кто исполнял (для поиска поддержки). Гость/вебхук — NULL, их различает `principal`
  "user_id"       UUID,
  -- Вид принципала: user | api_key | bot | guest | webhook
  "principal"     TEXT         NOT NULL,
  "workspace_id"  UUID,
  "api_key_id"    TEXT,
  "method"        TEXT         NOT NULL,
  "route"         TEXT         NOT NULL,
  -- HMAC-тег формы запроса (`KeysMacService.tagged`, имя `idempotency`): тот же ключ
  -- с другим телом обязан получить 422, а не чужой ответ
  "fingerprint"   TEXT         NOT NULL,
  -- in_progress | committed | completed | released
  "state"         TEXT         NOT NULL,
  -- Номер попытки: fencing-токен (устаревшая попытка не вправе ничего дописать)
  "attempt"       INTEGER      NOT NULL DEFAULT 1,
  "lease_until"   TIMESTAMP(3),
  -- Ручка обещала «ровно одна транзакция, безопасно пере-исполнить»
  "atomic"        BOOLEAN      NOT NULL DEFAULT false,
  "http_status"   INTEGER,
  "error_code"    TEXT,
  -- Ссылка на созданную сущность — её показывает `409 already_completed`
  "resource_id"   TEXT,
  -- Строка снимка в idem.responses (id + день партиции; тела может не быть вовсе)
  "response_id"   BIGINT,
  "response_at"   TIMESTAMP(3),
  "replays"       INTEGER      NOT NULL DEFAULT 0,
  "last_seen_at"  TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  -- Версия сборки, исполнившей запрос (диагностика снимков старой формы DTO)
  "build"         TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "completed_at"  TIMESTAMP(3),
  "expires_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "idem_keys_pkey" PRIMARY KEY ("scope_hash", "key_hash")
) PARTITION BY HASH ("scope_hash", "key_hash");

-- Чистка по сроку и поиск поддержки «спорные операции человека»
CREATE INDEX "idem_keys_expires_at_idx"      ON idem.keys ("expires_at");
CREATE INDEX "idem_keys_user_created_at_idx" ON idem.keys ("user_id", "created_at") WHERE "user_id" IS NOT NULL;

DO $$
DECLARE i int; part text;
BEGIN
  FOR i IN 0..15 LOOP
    part := 'keys_p' || lpad(i::text, 2, '0');
    EXECUTE format(
      'CREATE TABLE idem.%I PARTITION OF idem.keys FOR VALUES WITH (MODULUS 16, REMAINDER %s)', part, i
    );
    -- Строка живёт неделю и переписывается несколько раз (in_progress → committed →
    -- completed, плюс replays/last_seen_at) — место под HOT-обновления в странице.
    -- Вакуум по ОБЪЁМУ изменений, а не по доле строк: иначе мёртвые кортежи распухают.
    EXECUTE format(
      'ALTER TABLE idem.%I SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05)',
      part
    );
  END LOOP;
END $$;

-- ---------- idem.responses: снимок тела (72 ч), партиции по дню ----------
-- Уникальности здесь НЕТ намеренно: правда о ключе — в idem.keys, тело всего лишь
-- «есть или нет». Не нашли/не расшифровали (KEK уничтожен вместе с аккаунтом) —
-- реплей отвечает `already_completed`, а не падает.
CREATE SEQUENCE idem.responses_id_seq;

CREATE TABLE idem.responses (
  "id"         BIGINT       NOT NULL DEFAULT nextval('idem.responses_id_seq'),
  "at"         TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  -- Чей KEK шифрует строку: человек → user, бот/ключ организации → workspace, гость → platform.
  -- Колонки нужны перешивке после ротации KEK (`KeysFieldRegistry`): без них старая
  -- версия KEK осталась бы `active` навсегда.
  "scope_type" TEXT         NOT NULL,
  "scope_id"   UUID,
  -- Тело под KEK владельца (`sa6e:…`): удаление аккаунта уносит ключ → снимок нечитаем
  "body_enc"   TEXT         NOT NULL,
  "bytes"      INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT "idem_responses_pkey" PRIMARY KEY ("id", "at")
) PARTITION BY RANGE ("at");

-- Перешивка ищет строки скоупа: (scope_type, scope_id) — её единственный фильтр
CREATE INDEX "idem_responses_scope_idx" ON idem.responses ("scope_type", "scope_id");

ALTER SEQUENCE idem.responses_id_seq OWNED BY idem.responses."id";

DO $$
DECLARE d date; hi date; part text;
BEGIN
  FOR d IN SELECT (date_trunc('day', (now() AT TIME ZONE 'UTC')) + make_interval(days => i))::date FROM generate_series(-1, 4) AS i
  LOOP
    hi := (d + interval '1 day')::date;
    part := 'responses_' || to_char(d, 'YYYY_MM_DD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS idem.%I PARTITION OF idem.responses FOR VALUES FROM (%L) TO (%L)', part, d::timestamp, hi::timestamp
    );
    EXECUTE format(
      'ALTER TABLE idem.%I SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05)', part
    );
  END LOOP;
END $$;

-- ---------- Входящий ящик «ровно один раз» (Prisma-модель, схема public) ----------
CREATE TABLE "idempotency_inbox" (
  "id"          BIGSERIAL    NOT NULL,
  -- Источник: livekit | telegram | scheduler | …
  "source"      TEXT         NOT NULL,
  -- Аккаунт/канал внутри источника (id бота, id комнаты, ключ расписания)
  "account"     TEXT         NOT NULL,
  -- Идентификатор события у источника (event.id, update_id, periodKey)
  "event_id"    TEXT         NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "idempotency_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_inbox_source_account_event_id_key"
  ON "idempotency_inbox" ("source", "account", "event_id");
CREATE INDEX "idempotency_inbox_received_at_idx" ON "idempotency_inbox" ("received_at");
