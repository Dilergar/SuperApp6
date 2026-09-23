-- ============================================================
-- core/audit — ревью журнала безопасности
-- ============================================================
-- 1) `audit_drop_partition`: пол «3 года» и границы месяца берутся из ИМЕНИ партиции, а не из
--    строки `security_partition_archives` — её пишет роль приложения (INSERT разрешён), и подложная
--    строка с `to_at` в прошлом открывала сброс ТЕКУЩЕГО месяца функцией владельца. Строка архива
--    обязана описывать ровно этот месяц.
-- 2) `audit_ensure_partition`: чужая таблица с именем будущей партиции больше не глотается молча
--    (вставки месяца падали бы «no partition of relation») — громкий отказ.
-- 3) SECURITY DEFINER-функции закрыты от PUBLIC и в самой миграции (db-roles.sql выдаёт роли приложения).
-- 4) Индексы журнала: лента Кабинета без фильтров (ORDER BY occurred_at DESC, id DESC LIMIT n) шла
--    полным чтением и сортировкой всей таблицы — BRIN порядок не даёт. B-tree (occurred_at, id)
--    вместо BRIN; разреженные колонки (op, ip_hmac, request_id, цель) — частичные индексы без NULL
--    (равенство `col = $1` планировщик сводит к `col IS NOT NULL` — индекс используется).
-- 5) Версия формулы листа Меркла (`leaf_version`): v1 = `to_jsonb(e)` — новая колонка журнала
--    меняла текст КАЖДОЙ строки и роняла проверку всех прошлых дайджестов и сброс архивов;
--    v2 = через `jsonb_strip_nulls` (пустая новая колонка лист не меняет). Прошлые строки — v1;
--    умолчание колонки — v1 (формула писателя, не знающего версии), новый код пишет версию явно.
-- 6) `security_digests.xact_to` — уникальный индекс: крон дайджестов ищет последний дайджест
--    каждую минуту, проверка цепочки — предыдущий по `xact_to` (было — полное чтение таблицы).
-- 7) `user_devices.forgotten_at` — частичный индекс для ночной чистки забытых устройств.
-- ============================================================

-- ---------- 1) Сброс партиции ----------
CREATE OR REPLACE FUNCTION audit_drop_partition(p_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  arch record;
  lo   timestamp;
  hi   timestamp;
BEGIN
  IF p_name !~ '^security_events_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'audit_drop_partition: not a security_events partition: %', p_name;
  END IF;
  -- Границы месяца — из имени (его формат проверен выше), не из данных роли приложения
  lo := to_date(substr(p_name, 17), 'YYYY_MM')::timestamp;
  hi := lo + interval '1 month';
  SELECT * INTO arch FROM "security_partition_archives" WHERE "partition" = p_name;
  IF NOT FOUND OR arch."archived_at" IS NULL THEN
    RAISE EXCEPTION 'audit_drop_partition: % is not archived — refusing to drop', p_name;
  END IF;
  IF arch."from_at" <> lo OR arch."to_at" <> hi THEN
    RAISE EXCEPTION 'audit_drop_partition: the archive record of % does not describe its month — refusing to drop', p_name;
  END IF;
  IF hi > (now() AT TIME ZONE 'UTC') - interval '3 years' THEN
    RAISE EXCEPTION 'audit_drop_partition: % is younger than the 3-year retention floor', p_name;
  END IF;
  IF to_regclass('public.' || p_name) IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('ALTER TABLE "security_events" DETACH PARTITION %I', p_name);
  EXECUTE format('DROP TABLE %I', p_name);
  UPDATE "security_partition_archives" SET "dropped_at" = (now() AT TIME ZONE 'UTC') WHERE "partition" = p_name;
  RETURN true;
END;
$$;

-- ---------- 2) Партиция месяца ----------
CREATE OR REPLACE FUNCTION audit_ensure_partition(p_month date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  lo   date := date_trunc('month', p_month)::date;
  hi   date := (date_trunc('month', p_month) + interval '1 month')::date;
  name text := 'security_events_' || to_char(date_trunc('month', p_month), 'YYYY_MM');
  rel  regclass;
BEGIN
  rel := to_regclass('public.' || name);
  IF rel IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF "security_events" FOR VALUES FROM (%L) TO (%L)', name, lo::timestamp, hi::timestamp);
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "details" SET COMPRESSION lz4', name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "evidence" SET COMPRESSION lz4', name);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER "security_events_guard"', name);
    EXECUTE format('CREATE TRIGGER "security_events_no_truncate" BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION security_events_no_truncate()', name);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER "security_events_no_truncate"', name);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = rel AND inhparent = '"security_events"'::regclass) THEN
    RAISE EXCEPTION 'audit_ensure_partition: % exists but is not a partition of security_events', name;
  END IF;
  RETURN name;
END;
$$;

-- ---------- 3) Функции владельца — не для PUBLIC ----------
REVOKE ALL ON FUNCTION audit_ensure_partition(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_drop_partition(text) FROM PUBLIC;

-- ---------- 4) Индексы журнала ----------
DROP INDEX IF EXISTS "security_events_occurred_at_idx";
CREATE INDEX "security_events_occurred_at_id_idx" ON "security_events" ("occurred_at" DESC, "id" DESC);

DROP INDEX IF EXISTS "security_events_op_occurred_at_idx";
CREATE INDEX "security_events_op_occurred_at_idx" ON "security_events" ("op", "occurred_at" DESC) WHERE "op" IS NOT NULL;

DROP INDEX IF EXISTS "security_events_ip_hmac_occurred_at_idx";
CREATE INDEX "security_events_ip_hmac_occurred_at_idx" ON "security_events" ("ip_hmac", "occurred_at" DESC) WHERE "ip_hmac" IS NOT NULL;

DROP INDEX IF EXISTS "security_events_request_id_idx";
CREATE INDEX "security_events_request_id_idx" ON "security_events" ("request_id") WHERE "request_id" IS NOT NULL;

DROP INDEX IF EXISTS "security_events_target_type_target_id_occurred_at_idx";
CREATE INDEX "security_events_target_type_target_id_occurred_at_idx" ON "security_events" ("target_type", "target_id", "occurred_at" DESC) WHERE "target_id" IS NOT NULL;

-- ---------- 5) Версия формулы листа ----------
ALTER TABLE "security_digests" ADD COLUMN "leaf_version" SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE "security_digests" ADD CONSTRAINT "security_digests_leaf_version_check" CHECK ("leaf_version" IN (1, 2));
ALTER TABLE "security_partition_archives" ADD COLUMN "leaf_version" SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE "security_partition_archives" ADD CONSTRAINT "security_partition_archives_leaf_version_check" CHECK ("leaf_version" IN (1, 2));

-- ---------- 6) Дайджесты: конец окна ----------
CREATE UNIQUE INDEX "security_digests_xact_to_key" ON "security_digests" ("xact_to");

-- ---------- 7) Устройства: чистка забытых ----------
CREATE INDEX "user_devices_forgotten_at_idx" ON "user_devices" ("forgotten_at") WHERE "forgotten_at" IS NOT NULL;
