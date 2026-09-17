-- ============================================================
-- core/keys: журналы обращений ключами (`api_access_log`) и чтений ПДн (`pii_access_log`)
-- становятся МЕСЯЧНЫМИ ПАРТИЦИЯМИ (прецедент analytics.events): ретеншн сбрасывает
-- партицию целиком (DETACH CONCURRENTLY + DROP) вместо DELETE миллионов строк.
-- Написано руками: Prisma не выражает PARTITION BY; в schema.prisma зеркало — составной
-- PK (id, <ts>) и комментарий у моделей. Данные переносятся, последовательность id
-- продолжается с прежнего максимума. Партиции: месяцы имеющихся строк + текущий и два
-- следующих; дальше — `MonthlyPartitions.ensureAhead()` на буте и кроном.
-- ============================================================

-- ---------- api_access_log ----------
ALTER TABLE "api_access_log" RENAME TO "api_access_log_old";
-- Имя PK и индексов у переименованной таблицы остаётся прежним — освобождаем его для нового родителя
ALTER TABLE "api_access_log_old" RENAME CONSTRAINT "api_access_log_pkey" TO "api_access_log_old_pkey";
ALTER INDEX IF EXISTS "api_access_log_key_id_at_idx" RENAME TO "api_access_log_old_key_id_at_idx";
ALTER INDEX IF EXISTS "api_access_log_at_idx" RENAME TO "api_access_log_old_at_idx";

CREATE TABLE "api_access_log" (
  "id"     BIGINT       NOT NULL,
  "key_id" TEXT         NOT NULL,
  "at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "method" TEXT         NOT NULL,
  "route"  TEXT         NOT NULL,
  "status" INTEGER      NOT NULL,
  "ip"     TEXT,
  CONSTRAINT "api_access_log_pkey" PRIMARY KEY ("id", "at")
) PARTITION BY RANGE ("at");

-- Индексы родителя наследуются каждой партицией (и созданными кроном)
CREATE INDEX "api_access_log_key_id_at_idx" ON "api_access_log" ("key_id", "at");
CREATE INDEX "api_access_log_at_idx" ON "api_access_log" USING brin ("at");

DO $$
DECLARE
  m  date;
  hi date;
BEGIN
  FOR m IN
    SELECT DISTINCT date_trunc('month', "at")::date FROM "api_access_log_old"
    UNION
    SELECT (date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i))::date FROM generate_series(0, 2) AS i
  LOOP
    hi := (m + interval '1 month')::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "api_access_log" FOR VALUES FROM (%L) TO (%L)',
      'api_access_log_' || to_char(m, 'YYYY_MM'), m::timestamp, hi::timestamp
    );
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', 'api_access_log_' || to_char(m, 'YYYY_MM'));
  END LOOP;
END $$;

INSERT INTO "api_access_log" ("id", "key_id", "at", "method", "route", "status", "ip")
SELECT "id", "key_id", "at", "method", "route", "status", "ip" FROM "api_access_log_old";

DROP TABLE "api_access_log_old";

-- Последовательность id: своя, продолжает прежний максимум (старую унёс DROP старой таблицы)
CREATE SEQUENCE "api_access_log_id_seq" OWNED BY "api_access_log"."id";
ALTER TABLE "api_access_log" ALTER COLUMN "id" SET DEFAULT nextval('api_access_log_id_seq');
SELECT setval('api_access_log_id_seq', COALESCE((SELECT MAX("id") FROM "api_access_log"), 0) + 1, false);

-- ---------- pii_access_log ----------
ALTER TABLE "pii_access_log" RENAME TO "pii_access_log_old";
ALTER TABLE "pii_access_log_old" RENAME CONSTRAINT "pii_access_log_pkey" TO "pii_access_log_old_pkey";
ALTER INDEX IF EXISTS "pii_access_log_occurred_at_idx" RENAME TO "pii_access_log_old_occurred_at_idx";
ALTER INDEX IF EXISTS "pii_access_log_actor_id_occurred_at_idx" RENAME TO "pii_access_log_old_actor_id_occurred_at_idx";

CREATE TABLE "pii_access_log" (
  "id"           BIGINT       NOT NULL,
  "occurred_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_id"     TEXT,
  "actor_kind"   TEXT         NOT NULL DEFAULT 'user',
  "workspace_id" TEXT,
  "entity"       TEXT         NOT NULL,
  "fields"       TEXT[],
  "count"        INTEGER      NOT NULL,
  "sample_ids"   TEXT[],
  CONSTRAINT "pii_access_log_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "pii_access_log_occurred_at_idx" ON "pii_access_log" USING brin ("occurred_at");
CREATE INDEX "pii_access_log_actor_id_occurred_at_idx" ON "pii_access_log" ("actor_id", "occurred_at");

DO $$
DECLARE
  m  date;
  hi date;
BEGIN
  FOR m IN
    SELECT DISTINCT date_trunc('month', "occurred_at")::date FROM "pii_access_log_old"
    UNION
    SELECT (date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i))::date FROM generate_series(0, 2) AS i
  LOOP
    hi := (m + interval '1 month')::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "pii_access_log" FOR VALUES FROM (%L) TO (%L)',
      'pii_access_log_' || to_char(m, 'YYYY_MM'), m::timestamp, hi::timestamp
    );
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', 'pii_access_log_' || to_char(m, 'YYYY_MM'));
  END LOOP;
END $$;

INSERT INTO "pii_access_log" ("id", "occurred_at", "actor_id", "actor_kind", "workspace_id", "entity", "fields", "count", "sample_ids")
SELECT "id", "occurred_at", "actor_id", "actor_kind", "workspace_id", "entity", "fields", "count", "sample_ids" FROM "pii_access_log_old";

DROP TABLE "pii_access_log_old";

CREATE SEQUENCE "pii_access_log_id_seq" OWNED BY "pii_access_log"."id";
ALTER TABLE "pii_access_log" ALTER COLUMN "id" SET DEFAULT nextval('pii_access_log_id_seq');
SELECT setval('pii_access_log_id_seq', COALESCE((SELECT MAX("id") FROM "pii_access_log"), 0) + 1, false);
