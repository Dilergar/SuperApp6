-- ============================================================
-- core/audit (26-й движок) — журнал аудита безопасности
-- ============================================================
-- 1) `security_events` — ЕДИНЫЙ поток событий безопасности, МЕСЯЧНЫЕ ПАРТИЦИИ по `occurred_at`
--    (Prisma не выражает PARTITION BY — зеркало в schema.prisma: составной PK). Партиции создаёт
--    SECURITY DEFINER-функция `audit_ensure_partition` (владелец партиций = владелец таблицы, а
--    не роль приложения: роль приложения не может отключить триггер или сбросить партицию).
-- 2) Append-only НА УРОВНЕ БАЗЫ: `security_events_guard` роняет DELETE и любой UPDATE, кроме
--    перешивки шифротекста `ip_enc`/`ua_raw_enc` (ротация платформенного KEK); TRUNCATE — отдельным
--    триггером на родителе И на каждой партиции. Триггеры — ENABLE ALWAYS: их не глушит
--    `session_replication_role = replica` (NIST AU-9, ЕТ № 832 п. 38).
-- 3) Сброс партиции по сроку — ТОЛЬКО функцией `audit_drop_partition`: она требует строку архива
--    (выгрузка в объектное хранилище прошла) и возраст партиции ≥ 3 лет (пол ЕТ № 832 п. 38).
-- 4) В журнал переехали пять журналов: `key_audit_entries`, `platform_audit_entries`,
--    `platform_access_log`, `pii_access_log`, `pd_action_records` — таблицы удаляются (dev-строки
--    не переносятся: решение грилла №1). ПРОД: бэкап перед `migrate deploy` — DROP необратим.
-- 5) Сессии как объект для человека: мягкий отзыв, устройство, сеть, страна, cooling.
-- ============================================================

-- ---------- Сессии ----------
ALTER TABLE "sessions" RENAME COLUMN "last_active" TO "last_seen_at";
ALTER TABLE "sessions"
  ADD COLUMN "device_id" UUID,
  ADD COLUMN "ua_family" TEXT,
  ADD COLUMN "ip_net" TEXT,
  ADD COLUMN "country" CHAR(2),
  ADD COLUMN "client" TEXT,
  ADD COLUMN "family_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "revoked_reason" TEXT,
  ADD COLUMN "confirmed_at" TIMESTAMP(3);

-- Начало семейства = самая ранняя строка семейства; живые до cooling сессии — доверенные
UPDATE "sessions" s SET "family_created_at" = f."first_at", "confirmed_at" = f."first_at"
FROM (SELECT "family_id", MIN("created_at") AS "first_at" FROM "sessions" GROUP BY "family_id") f
WHERE s."family_id" = f."family_id";

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_reason_check" CHECK (
  "revoked_reason" IS NULL OR "revoked_reason" IN
  ('self', 'other_session', 'logout_all', 'password_change', 'phone_change', 'reset', 'reuse', 'not_me', 'freeze', 'admin', 'platform', 'inactive', 'deleted')
);
-- Головы живых семейств по активности — автозавершение неактивных и список «Устройства и сессии»
CREATE INDEX "sessions_live_heads_last_seen_idx" ON "sessions" ("last_seen_at") WHERE "revoked_at" IS NULL AND "rotated_at" IS NULL;
CREATE INDEX "sessions_user_id_family_created_at_idx" ON "sessions" ("user_id", "family_created_at" DESC);

-- ---------- Люди: защита входа и заморозка ----------
ALTER TABLE "users"
  ADD COLUMN "login_locked_until" TIMESTAMP(3),
  ADD COLUMN "security_frozen_at" TIMESTAMP(3),
  ADD COLUMN "security_frozen_reason" TEXT,
  ADD COLUMN "session_max_idle_days" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "users" ADD CONSTRAINT "users_security_frozen_reason_check" CHECK ("security_frozen_reason" IS NULL OR "security_frozen_reason" IN ('self', 'platform'));
ALTER TABLE "users" ADD CONSTRAINT "users_session_max_idle_days_check" CHECK ("session_max_idle_days" IN (7, 30, 90, 180));

-- ---------- Старые журналы: переехали в security_events ----------
DROP TABLE "key_audit_entries";
DROP TABLE "platform_audit_entries";
DROP TABLE "platform_access_log";
DROP TABLE "pii_access_log";
DROP TABLE "pd_action_records";
DROP FUNCTION IF EXISTS key_audit_entries_immutable();
DROP FUNCTION IF EXISTS key_audit_entries_no_truncate();
DROP FUNCTION IF EXISTS platform_audit_entries_immutable();
DROP FUNCTION IF EXISTS platform_audit_entries_no_truncate();
-- consents_append_only() остаётся: её держат события инцидентов ПДн

-- ---------- security_events ----------
CREATE SEQUENCE "security_events_id_seq";

CREATE TABLE "security_events" (
  "id"                   BIGINT       NOT NULL DEFAULT nextval('security_events_id_seq'),
  "event_id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "occurred_at"          TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'::text),
  "tx_at"                TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'::text),
  "xact"                 xid8                  DEFAULT pg_current_xact_id(),
  "event_key"            TEXT         NOT NULL,
  "op"                   TEXT,
  "category"             SMALLINT     NOT NULL,
  "severity"             SMALLINT     NOT NULL,
  "outcome"              SMALLINT     NOT NULL,
  "reason_code"          TEXT,
  "actor_kind"           SMALLINT     NOT NULL,
  "actor_id"             UUID,
  "actor_session_id"     UUID,
  "actor_family_id"      UUID,
  "actor_key_id"         UUID,
  "on_behalf_of_id"      UUID,
  "actor_roles"          JSONB,
  "subject_user_id"      UUID,
  "workspace_id"         UUID,
  "target_type"          TEXT,
  "target_id"            TEXT,
  "target_label"         TEXT,
  "related"              JSONB,
  "vis_subject"          BOOLEAN      NOT NULL,
  "vis_workspace"        BOOLEAN      NOT NULL,
  "vis_platform"         BOOLEAN      NOT NULL DEFAULT true,
  "ip_enc"               TEXT,
  "ip_hmac"              TEXT,
  "ip_net"               TEXT,
  "country"              CHAR(2),
  "city"                 TEXT,
  "asn"                  INTEGER,
  "is_anonymizer"        BOOLEAN,
  "ua_family"            TEXT,
  "ua_raw_enc"           TEXT,
  "device_id"            UUID,
  "client"               SMALLINT,
  "request_id"           UUID,
  "route"                TEXT,
  "idempotency_key_hash" TEXT,
  "details"              JSONB        NOT NULL DEFAULT '{}',
  "evidence"             JSONB,
  "ref_type"             TEXT,
  "ref_id"               TEXT,
  CONSTRAINT "security_events_pkey" PRIMARY KEY ("id", "occurred_at"),
  CONSTRAINT "security_events_vis_platform_check" CHECK ("vis_platform"),
  CONSTRAINT "security_events_codes_check" CHECK ("category" BETWEEN 0 AND 63 AND "severity" BETWEEN 0 AND 4 AND "outcome" BETWEEN 0 AND 3 AND "actor_kind" BETWEEN 0 AND 15)
) PARTITION BY RANGE ("occurred_at");

ALTER SEQUENCE "security_events_id_seq" OWNED BY "security_events"."id";

-- Детали и доказательства — JSONB: lz4 быстрее pglz при той же степени сжатия
ALTER TABLE "security_events" ALTER COLUMN "details" SET COMPRESSION lz4;
ALTER TABLE "security_events" ALTER COLUMN "evidence" SET COMPRESSION lz4;

-- Индексы родителя наследуются каждой партицией. Время — BRIN (журнал растёт по времени);
-- ленты зрителей — keyset (occurred_at DESC, id DESC); курсор дайджестов — по xact.
CREATE INDEX "security_events_occurred_at_idx" ON "security_events" USING brin ("occurred_at");
CREATE INDEX "security_events_subject_user_id_occurred_at_id_idx" ON "security_events" ("subject_user_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "security_events_workspace_id_occurred_at_id_idx" ON "security_events" ("workspace_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "security_events_actor_id_occurred_at_idx" ON "security_events" ("actor_id", "occurred_at" DESC);
CREATE INDEX "security_events_event_key_occurred_at_idx" ON "security_events" ("event_key", "occurred_at" DESC);
CREATE INDEX "security_events_op_occurred_at_idx" ON "security_events" ("op", "occurred_at" DESC);
CREATE INDEX "security_events_ip_hmac_occurred_at_idx" ON "security_events" ("ip_hmac", "occurred_at" DESC);
CREATE INDEX "security_events_request_id_idx" ON "security_events" ("request_id");
CREATE INDEX "security_events_target_type_target_id_occurred_at_idx" ON "security_events" ("target_type", "target_id", "occurred_at" DESC);
CREATE INDEX "security_events_xact_idx" ON "security_events" ("xact");
CREATE UNIQUE INDEX "security_events_event_id_occurred_at_key" ON "security_events" ("event_id", "occurred_at");

-- Неизменяемость: DELETE — никогда; UPDATE — только перешивка шифротекста IP/UA (envelope →
-- envelope). Сравнение строк целиком без двух колонок: новая колонка журнала защищена сразу.
CREATE OR REPLACE FUNCTION security_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'security_events is append-only (delete is forbidden)';
  END IF;
  IF (to_jsonb(NEW) - 'ip_enc' - 'ua_raw_enc') IS DISTINCT FROM (to_jsonb(OLD) - 'ip_enc' - 'ua_raw_enc') THEN
    RAISE EXCEPTION 'security_events is append-only (only a re-encryption of ip_enc/ua_raw_enc may change a row)';
  END IF;
  IF (OLD."ip_enc" IS NOT NULL AND (NEW."ip_enc" IS NULL OR NEW."ip_enc" NOT LIKE 'sa6e:%'))
     OR (OLD."ua_raw_enc" IS NOT NULL AND (NEW."ua_raw_enc" IS NULL OR NEW."ua_raw_enc" NOT LIKE 'sa6e:%'))
     OR (OLD."ip_enc" IS NULL AND NEW."ip_enc" IS NOT NULL)
     OR (OLD."ua_raw_enc" IS NULL AND NEW."ua_raw_enc" IS NOT NULL) THEN
    RAISE EXCEPTION 'security_events: a re-encryption must replace an envelope with an envelope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION security_events_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only (truncate is forbidden)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "security_events_guard" BEFORE UPDATE OR DELETE ON "security_events" FOR EACH ROW EXECUTE FUNCTION security_events_guard();
ALTER TABLE "security_events" ENABLE ALWAYS TRIGGER "security_events_guard";
CREATE TRIGGER "security_events_no_truncate" BEFORE TRUNCATE ON "security_events" FOR EACH STATEMENT EXECUTE FUNCTION security_events_no_truncate();
ALTER TABLE "security_events" ENABLE ALWAYS TRIGGER "security_events_no_truncate";

-- Партиция месяца: создаётся владельцем таблицы (SECURITY DEFINER), со своими TRUNCATE-триггером
-- и ENABLE ALWAYS у клонированного построчного стража (партицию можно TRUNCATE напрямую,
-- минуя родителя). Имя и границы — только из чисел (инъекции нет).
CREATE OR REPLACE FUNCTION audit_ensure_partition(p_month date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  lo   date := date_trunc('month', p_month)::date;
  hi   date := (date_trunc('month', p_month) + interval '1 month')::date;
  name text := 'security_events_' || to_char(date_trunc('month', p_month), 'YYYY_MM');
BEGIN
  IF to_regclass('public.' || name) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF "security_events" FOR VALUES FROM (%L) TO (%L)', name, lo::timestamp, hi::timestamp);
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "details" SET COMPRESSION lz4', name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "evidence" SET COMPRESSION lz4', name);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER "security_events_guard"', name);
    EXECUTE format('CREATE TRIGGER "security_events_no_truncate" BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION security_events_no_truncate()', name);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER "security_events_no_truncate"', name);
  END IF;
  RETURN name;
END;
$$;

-- Сброс партиции по сроку: только выгруженной в архив и не моложе 3 лет. DETACH без CONCURRENTLY
-- (внутри функции он невозможен) — короткая блокировка родителя раз в месяц.
CREATE OR REPLACE FUNCTION audit_drop_partition(p_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  arch record;
BEGIN
  IF p_name !~ '^security_events_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'audit_drop_partition: not a security_events partition: %', p_name;
  END IF;
  SELECT * INTO arch FROM "security_partition_archives" WHERE "partition" = p_name;
  IF NOT FOUND OR arch."archived_at" IS NULL THEN
    RAISE EXCEPTION 'audit_drop_partition: % is not archived — refusing to drop', p_name;
  END IF;
  IF arch."to_at" > (now() AT TIME ZONE 'UTC') - interval '3 years' THEN
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

-- Текущий месяц и два следующих; дальше — `AuditPartitions.ensureAhead()` на буте и кроном
SELECT audit_ensure_partition((date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i))::date) FROM generate_series(0, 2) AS i;

-- ---------- Дайджесты ----------
CREATE TABLE "security_digests" (
  "id"               TEXT         NOT NULL,
  "xact_from"        BIGINT       NOT NULL,
  "xact_to"          BIGINT       NOT NULL,
  "first_at"         TIMESTAMP(3),
  "last_at"          TIMESTAMP(3),
  "count"            INTEGER      NOT NULL,
  "merkle_root"      BYTEA        NOT NULL,
  "prev_digest_hash" BYTEA,
  "signature"        BYTEA        NOT NULL,
  "kid"              TEXT         NOT NULL,
  "signed_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exported_at"      TIMESTAMP(3),
  "verified_at"      TIMESTAMP(3),
  "verify_ok"        BOOLEAN,
  CONSTRAINT "security_digests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "security_digests_range_check" CHECK ("xact_from" <= "xact_to")
);
CREATE UNIQUE INDEX "security_digests_xact_from_key" ON "security_digests" ("xact_from");
CREATE INDEX "security_digests_signed_at_idx" ON "security_digests" ("signed_at");

-- Дайджест неизменяем, кроме отметок выгрузки и проверки
CREATE OR REPLACE FUNCTION security_digests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'security_digests is append-only';
  END IF;
  IF (to_jsonb(NEW) - 'exported_at' - 'verified_at' - 'verify_ok') IS DISTINCT FROM (to_jsonb(OLD) - 'exported_at' - 'verified_at' - 'verify_ok') THEN
    RAISE EXCEPTION 'security_digests: only export and verification marks may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "security_digests_guard" BEFORE UPDATE OR DELETE ON "security_digests" FOR EACH ROW EXECUTE FUNCTION security_digests_guard();
ALTER TABLE "security_digests" ENABLE ALWAYS TRIGGER "security_digests_guard";
CREATE TRIGGER "security_digests_no_truncate" BEFORE TRUNCATE ON "security_digests" FOR EACH STATEMENT EXECUTE FUNCTION security_events_no_truncate();
ALTER TABLE "security_digests" ENABLE ALWAYS TRIGGER "security_digests_no_truncate";

-- ---------- Архив партиций ----------
CREATE TABLE "security_partition_archives" (
  "partition"    TEXT         NOT NULL,
  "from_at"      TIMESTAMP(3) NOT NULL,
  "to_at"        TIMESTAMP(3) NOT NULL,
  "rows"         INTEGER      NOT NULL,
  "bytes"        BIGINT       NOT NULL,
  "sha256"       TEXT         NOT NULL,
  "object_key"   TEXT         NOT NULL,
  "manifest_key" TEXT         NOT NULL,
  "signature"    BYTEA        NOT NULL,
  "kid"          TEXT         NOT NULL,
  "archived_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dropped_at"   TIMESTAMP(3),
  CONSTRAINT "security_partition_archives_pkey" PRIMARY KEY ("partition")
);

CREATE OR REPLACE FUNCTION security_partition_archives_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'security_partition_archives is append-only';
  END IF;
  IF OLD."dropped_at" IS NOT NULL OR (to_jsonb(NEW) - 'dropped_at') IS DISTINCT FROM (to_jsonb(OLD) - 'dropped_at') THEN
    RAISE EXCEPTION 'security_partition_archives: only the drop mark may be set, once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "security_partition_archives_guard" BEFORE UPDATE OR DELETE ON "security_partition_archives" FOR EACH ROW EXECUTE FUNCTION security_partition_archives_guard();
ALTER TABLE "security_partition_archives" ENABLE ALWAYS TRIGGER "security_partition_archives_guard";

-- ---------- Квитанции команд Кабинета ----------
CREATE TABLE "platform_command_receipts" (
  "actor_id"        UUID         NOT NULL,
  "command_key"     TEXT         NOT NULL,
  "idempotency_key" TEXT         NOT NULL,
  "input_hash"      TEXT,
  "event_id"        UUID         NOT NULL,
  "event_at"        TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_command_receipts_pkey" PRIMARY KEY ("actor_id", "command_key", "idempotency_key")
);
CREATE OR REPLACE FUNCTION platform_command_receipts_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_command_receipts is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "platform_command_receipts_guard" BEFORE UPDATE OR DELETE ON "platform_command_receipts" FOR EACH ROW EXECUTE FUNCTION platform_command_receipts_guard();
ALTER TABLE "platform_command_receipts" ENABLE ALWAYS TRIGGER "platform_command_receipts_guard";

-- ---------- Устройства ----------
CREATE TABLE "user_devices" (
  "id"            TEXT         NOT NULL,
  "user_id"       TEXT         NOT NULL,
  "device_id"     UUID         NOT NULL,
  "label"         TEXT         NOT NULL,
  "custom_label"  TEXT,
  "platform"      TEXT,
  "browser"       TEXT,
  "device_class"  TEXT         NOT NULL DEFAULT 'other',
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_country"  CHAR(2),
  "trusted_at"    TIMESTAMP(3),
  "forgotten_at"  TIMESTAMP(3),
  CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_devices_device_class_check" CHECK ("device_class" IN ('desktop', 'mobile', 'tablet', 'other'))
);
CREATE UNIQUE INDEX "user_devices_user_id_device_id_key" ON "user_devices" ("user_id", "device_id");
CREATE INDEX "user_devices_last_seen_at_idx" ON "user_devices" ("last_seen_at");
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- Тревоги ----------
CREATE TABLE "security_alerts" (
  "id"              TEXT         NOT NULL,
  "kind"            TEXT         NOT NULL,
  "severity"        TEXT         NOT NULL,
  "dedupe_key"      TEXT         NOT NULL,
  "subject_user_id" UUID,
  "workspace_id"    UUID,
  "ip_hmac"         TEXT,
  "status"          TEXT         NOT NULL DEFAULT 'open',
  "evidence"        JSONB        NOT NULL DEFAULT '[]',
  "hits"            INTEGER      NOT NULL DEFAULT 1,
  "assignee_id"     UUID,
  "resolution"      TEXT,
  "opened_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "closed_at"       TIMESTAMP(3),
  CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "security_alerts_status_check" CHECK ("status" IN ('open', 'ack', 'closed')),
  CONSTRAINT "security_alerts_severity_check" CHECK ("severity" IN ('info', 'low', 'medium', 'high', 'critical'))
);
CREATE INDEX "security_alerts_status_opened_at_idx" ON "security_alerts" ("status", "opened_at");
CREATE INDEX "security_alerts_subject_user_id_idx" ON "security_alerts" ("subject_user_id");
-- Одна НЕзакрытая тревога на (вид, ключ дедупликации): повтор наращивает `hits` и улики
CREATE UNIQUE INDEX "security_alerts_open_uq" ON "security_alerts" ("kind", "dedupe_key") WHERE "status" IN ('open', 'ack');
