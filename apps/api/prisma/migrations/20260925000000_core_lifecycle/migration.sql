-- core/lifecycle (28-й движок) — жизненный цикл данных.
--   1. таблицы движка (настройки сроков, заморозки, стирание и журнал, экспорт, учёт удалений,
--      прогоны, отчёты резервного копирования, правила и архивы партиций);
--   2. функции ВЛАДЕЛЬЦА партиций: создание = CREATE + CHECK границ + ATTACH (SHARE UPDATE
--      EXCLUSIVE на родителя, не ACCESS EXCLUSIVE), сброс — пол срока, архив и заморозка
--      проверяются в базе, а не в коде приложения;
--   3. notification_deliveries и webhook_deliveries → RANGE-партиции по месяцу created_at;
--   4. append-only: леджер, история скинов, журнал книги финансов, «личность» строк эскроу;
--   5. мягкое скрытие задач, событий календаря, записей диктофона; индексы под раннер purge;
--   6. хранение: fillfactor/автовакуум очереди джобов и сессий, lz4 у крупных JSON, BRIN леджера.
SET lock_timeout = '3s';
SET statement_timeout = '600s';

-- ============================================================
-- 1. Таблицы движка
-- ============================================================
CREATE TABLE "lifecycle_settings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspace_id" UUID NOT NULL,
    "data_class" TEXT NOT NULL,
    "days" INTEGER,
    "pending_set" BOOLEAN NOT NULL DEFAULT false,
    "pending_days" INTEGER,
    "pending_effective_at" TIMESTAMPTZ(3),
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lifecycle_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lifecycle_settings_days_check" CHECK ("days" IS NULL OR "days" >= 1),
    CONSTRAINT "lifecycle_settings_pending_days_check" CHECK ("pending_days" IS NULL OR "pending_days" >= 1),
    CONSTRAINT "lifecycle_settings_pending_check" CHECK ("pending_set" = ("pending_effective_at" IS NOT NULL))
);

CREATE TABLE "lifecycle_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "workspace_id" UUID,
    "custodian_user_id" UUID,
    "space_type" TEXT,
    "space_id" TEXT,
    "record_type" TEXT,
    "record_id" TEXT,
    "data_class" TEXT,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_by_kind" TEXT NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "released_by_id" UUID,
    "release_note" TEXT,
    CONSTRAINT "lifecycle_holds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lifecycle_holds_scope_check" CHECK ("scope" IN ('custodian', 'space', 'record', 'class')),
    CONSTRAINT "lifecycle_holds_target_check" CHECK (
      ("scope" = 'custodian' AND "custodian_user_id" IS NOT NULL) OR
      ("scope" = 'space' AND "space_type" IS NOT NULL AND "space_id" IS NOT NULL) OR
      ("scope" = 'record' AND "record_type" IS NOT NULL AND "record_id" IS NOT NULL) OR
      ("scope" = 'class' AND "data_class" IS NOT NULL)
    ),
    CONSTRAINT "lifecycle_holds_kind_check" CHECK ("created_by_kind" IN ('user', 'platform_staff')),
    CONSTRAINT "lifecycle_holds_note_check" CHECK ("note" IS NULL OR length("note") <= 500),
    CONSTRAINT "lifecycle_holds_release_check" CHECK (("released_at" IS NULL) = ("released_by_id" IS NULL))
);

CREATE TABLE "lifecycle_hold_store" (
    "id" BIGSERIAL NOT NULL,
    "hold_id" UUID NOT NULL,
    "policy_id" TEXT NOT NULL,
    "source_table" TEXT NOT NULL,
    "source_pk" TEXT NOT NULL,
    "partition" TEXT,
    "row_enc" BYTEA NOT NULL,
    "key_scope" TEXT NOT NULL,
    "extracted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lifecycle_hold_store_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lifecycle_erasure_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "pseudonym" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "hidden_at" TIMESTAMPTZ(3),
    "hot_purged_at" TIMESTAMPTZ(3),
    "keys_destroyed_at" TIMESTAMPTZ(3),
    "backups_clear_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "last_progress_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "receipt_hash" TEXT,
    "certificate" JSONB,
    "signature" BYTEA,
    "kid" TEXT,
    CONSTRAINT "lifecycle_erasure_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lifecycle_erasure_requests_subject_check" CHECK ("subject_type" IN ('user', 'workspace')),
    CONSTRAINT "lifecycle_erasure_requests_status_check" CHECK ("status" IN ('scheduled', 'running', 'hot_purged', 'keys_destroyed', 'completed', 'cancelled', 'failed'))
);

CREATE TABLE "lifecycle_erasure_journal" (
    "id" BIGSERIAL NOT NULL,
    "request_id" UUID NOT NULL,
    "pseudonym" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "policy_id" TEXT,
    "policy_version" INTEGER,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "key_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" TIMESTAMPTZ(3),
    CONSTRAINT "lifecycle_erasure_journal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lifecycle_exports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "manifest" JSONB,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "max_downloads" INTEGER NOT NULL DEFAULT 5,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    CONSTRAINT "lifecycle_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lifecycle_exports_subject_check" CHECK ("subject_type" IN ('user', 'workspace')),
    CONSTRAINT "lifecycle_exports_status_check" CHECK ("status" IN ('queued', 'running', 'ready', 'failed', 'expired')),
    CONSTRAINT "lifecycle_exports_downloads_check" CHECK ("downloads" >= 0 AND "downloads" <= "max_downloads")
);

-- Учёт удалений без FK: RANGE по дню deleted_at (партиции — функцией владельца ниже)
CREATE TABLE "lifecycle_deleted_rows" (
    "id" BIGSERIAL NOT NULL,
    "table_name" TEXT NOT NULL,
    "row_id" UUID NOT NULL,
    "workspace_id" UUID,
    "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    CONSTRAINT "lifecycle_deleted_rows_pkey" PRIMARY KEY ("id", "deleted_at")
) PARTITION BY RANGE ("deleted_at");

CREATE TABLE "lifecycle_runs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "policy_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "rows" BIGINT NOT NULL DEFAULT 0,
    "batches" INTEGER NOT NULL DEFAULT 0,
    "expected_rows" BIGINT,
    "stopped_reason" TEXT,
    "report" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "lifecycle_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lifecycle_runs_status_check" CHECK ("status" IN ('running', 'done', 'stopped', 'failed'))
);

CREATE TABLE "lifecycle_backup_runs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "bytes" BIGINT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lifecycle_backup_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lifecycle_backup_runs_status_check" CHECK ("status" IN ('ok', 'failed'))
);

CREATE TABLE "lifecycle_partition_specs" (
    "parent" TEXT NOT NULL,
    "column_name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "floor_days" INTEGER NOT NULL,
    "require_archive" BOOLEAN NOT NULL DEFAULT false,
    "ahead_periods" INTEGER NOT NULL DEFAULT 3,
    "insert_scale" DOUBLE PRECISION,
    "lz4_columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "always_triggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "no_truncate_function" TEXT,
    "policy_id" TEXT NOT NULL,
    "data_class" TEXT NOT NULL,
    "hold_aware" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "lifecycle_partition_specs_pkey" PRIMARY KEY ("parent"),
    CONSTRAINT "lifecycle_partition_specs_period_check" CHECK ("period" IN ('day', 'month')),
    CONSTRAINT "lifecycle_partition_specs_floor_check" CHECK ("floor_days" >= 1),
    CONSTRAINT "lifecycle_partition_specs_ahead_check" CHECK ("ahead_periods" BETWEEN 2 AND 24)
);

CREATE TABLE "lifecycle_partition_archives" (
    "partition" TEXT NOT NULL,
    "parent" TEXT NOT NULL,
    "from_at" TIMESTAMPTZ(3) NOT NULL,
    "to_at" TIMESTAMPTZ(3) NOT NULL,
    "rows" BIGINT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "signature" BYTEA NOT NULL,
    "kid" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dropped_at" TIMESTAMPTZ(3),
    CONSTRAINT "lifecycle_partition_archives_pkey" PRIMARY KEY ("partition")
);

-- Отметка «строки заморозки из этой партиции извлечены»: без неё функция владельца не
-- сбросит партицию hold-aware политики, пока заморозка жива
CREATE TABLE "lifecycle_hold_extractions" (
    "hold_id" UUID NOT NULL,
    "partition" TEXT NOT NULL,
    "rows" BIGINT NOT NULL,
    "extracted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lifecycle_hold_extractions_pkey" PRIMARY KEY ("hold_id", "partition"),
    CONSTRAINT "lifecycle_hold_extractions_rows_check" CHECK ("rows" >= 0)
);

CREATE UNIQUE INDEX "lifecycle_settings_workspace_id_data_class_key" ON "lifecycle_settings"("workspace_id", "data_class");
CREATE INDEX "lifecycle_holds_workspace_id_released_at_idx" ON "lifecycle_holds"("workspace_id", "released_at");
CREATE INDEX "lifecycle_holds_custodian_user_id_released_at_idx" ON "lifecycle_holds"("custodian_user_id", "released_at");
CREATE INDEX "lifecycle_holds_record_type_record_id_idx" ON "lifecycle_holds"("record_type", "record_id");
CREATE INDEX "lifecycle_holds_space_type_space_id_idx" ON "lifecycle_holds"("space_type", "space_id");
CREATE INDEX "lifecycle_hold_store_hold_id_idx" ON "lifecycle_hold_store"("hold_id");
CREATE UNIQUE INDEX "lifecycle_erasure_requests_receipt_hash_key" ON "lifecycle_erasure_requests"("receipt_hash");
CREATE INDEX "lifecycle_erasure_requests_status_effective_at_idx" ON "lifecycle_erasure_requests"("status", "effective_at");
CREATE INDEX "lifecycle_erasure_requests_subject_type_subject_id_idx" ON "lifecycle_erasure_requests"("subject_type", "subject_id");
-- Одна живая заявка на субъект (двойной запуск мастера удаления не плодит заявки)
CREATE UNIQUE INDEX "lifecycle_erasure_requests_one_live" ON "lifecycle_erasure_requests"("subject_type", "subject_id") WHERE "status" NOT IN ('completed', 'cancelled', 'failed');
CREATE INDEX "lifecycle_erasure_journal_request_id_idx" ON "lifecycle_erasure_journal"("request_id");
CREATE INDEX "lifecycle_erasure_journal_at_idx" ON "lifecycle_erasure_journal"("at");
CREATE INDEX "lifecycle_exports_subject_type_subject_id_created_at_idx" ON "lifecycle_exports"("subject_type", "subject_id", "created_at" DESC);
CREATE INDEX "lifecycle_deleted_rows_table_name_processed_at_idx" ON "lifecycle_deleted_rows"("table_name", "processed_at");
CREATE INDEX "lifecycle_runs_policy_id_started_at_idx" ON "lifecycle_runs"("policy_id", "started_at" DESC);
CREATE INDEX "lifecycle_runs_kind_started_at_idx" ON "lifecycle_runs"("kind", "started_at" DESC);
CREATE INDEX "lifecycle_backup_runs_kind_started_at_idx" ON "lifecycle_backup_runs"("kind", "started_at" DESC);
ALTER TABLE "lifecycle_settings" ADD CONSTRAINT "lifecycle_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Заморозка: строка не удаляется и не меняется — кроме ОДНОГО перехода «снята» (released_*)
CREATE OR REPLACE FUNCTION lifecycle_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lifecycle_holds is append-only (a hold is released, never deleted)';
  END IF;
  IF OLD."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'lifecycle_holds: a released hold is immutable';
  END IF;
  IF (NEW."id", NEW."scope", NEW."workspace_id", NEW."custodian_user_id", NEW."space_type", NEW."space_id", NEW."record_type", NEW."record_id", NEW."data_class", NEW."reason_code", NEW."note", NEW."created_by_id", NEW."created_by_kind", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."scope", OLD."workspace_id", OLD."custodian_user_id", OLD."space_type", OLD."space_id", OLD."record_type", OLD."record_id", OLD."data_class", OLD."reason_code", OLD."note", OLD."created_by_id", OLD."created_by_kind", OLD."created_at") THEN
    RAISE EXCEPTION 'lifecycle_holds: only the release fields may change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "lifecycle_holds_guard" BEFORE UPDATE OR DELETE ON "lifecycle_holds" FOR EACH ROW EXECUTE FUNCTION lifecycle_holds_guard();
ALTER TABLE "lifecycle_holds" ENABLE ALWAYS TRIGGER "lifecycle_holds_guard";

-- Журнал стираний: только дописывается (метка выгрузки — единственное изменение)
CREATE OR REPLACE FUNCTION lifecycle_erasure_journal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lifecycle_erasure_journal is append-only';
  END IF;
  IF (NEW."id", NEW."request_id", NEW."pseudonym", NEW."stage", NEW."policy_id", NEW."policy_version", NEW."rows", NEW."key_ids", NEW."at")
     IS DISTINCT FROM
     (OLD."id", OLD."request_id", OLD."pseudonym", OLD."stage", OLD."policy_id", OLD."policy_version", OLD."rows", OLD."key_ids", OLD."at") THEN
    RAISE EXCEPTION 'lifecycle_erasure_journal: only exported_at may change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "lifecycle_erasure_journal_guard" BEFORE UPDATE OR DELETE ON "lifecycle_erasure_journal" FOR EACH ROW EXECUTE FUNCTION lifecycle_erasure_journal_guard();
ALTER TABLE "lifecycle_erasure_journal" ENABLE ALWAYS TRIGGER "lifecycle_erasure_journal_guard";

-- TRUNCATE — мимо строковых триггеров: отдельный запрет на уровне оператора
CREATE OR REPLACE FUNCTION lifecycle_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (truncate is forbidden)', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "lifecycle_holds_no_truncate" BEFORE TRUNCATE ON "lifecycle_holds" FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_no_truncate();
ALTER TABLE "lifecycle_holds" ENABLE ALWAYS TRIGGER "lifecycle_holds_no_truncate";
CREATE TRIGGER "lifecycle_erasure_journal_no_truncate" BEFORE TRUNCATE ON "lifecycle_erasure_journal" FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_no_truncate();
ALTER TABLE "lifecycle_erasure_journal" ENABLE ALWAYS TRIGGER "lifecycle_erasure_journal_no_truncate";

-- ============================================================
-- 2. Функции владельца партиций
-- ============================================================
-- Границы периода в UTC и суффикс имени листа: месяц `YYYY_MM`, день `YYYY_MM_DD`.
CREATE OR REPLACE FUNCTION lifecycle_partition_bounds(p_period text, p_at timestamptz, OUT lo timestamptz, OUT hi timestamptz, OUT suffix text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  base timestamp;
BEGIN
  IF p_period = 'month' THEN
    base := date_trunc('month', p_at AT TIME ZONE 'UTC');
    lo := base AT TIME ZONE 'UTC';
    hi := (base + interval '1 month') AT TIME ZONE 'UTC';
    suffix := to_char(base, 'YYYY_MM');
  ELSIF p_period = 'day' THEN
    base := date_trunc('day', p_at AT TIME ZONE 'UTC');
    lo := base AT TIME ZONE 'UTC';
    hi := (base + interval '1 day') AT TIME ZONE 'UTC';
    suffix := to_char(base, 'YYYY_MM_DD');
  ELSE
    RAISE EXCEPTION 'lifecycle_partition_bounds: unknown period %', p_period;
  END IF;
END;
$$;

-- Литерал границы под тип ключа партиции: timestamp без зоны — UTC без смещения, timestamptz — '+00'
CREATE OR REPLACE FUNCTION lifecycle_partition_literal(p_parent regclass, p_column text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  typ regtype;
BEGIN
  SELECT a.atttypid::regtype INTO typ FROM pg_attribute a WHERE a.attrelid = p_parent AND a.attname = p_column AND NOT a.attisdropped;
  IF typ IS NULL THEN
    RAISE EXCEPTION 'lifecycle_partition_literal: % has no column %', p_parent, p_column;
  END IF;
  IF typ = 'timestamp without time zone'::regtype THEN
    RETURN to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
  END IF;
  RETURN to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || '+00';
END;
$$;

-- Завести лист периода `p_at`: CREATE (LIKE родитель) + CHECK границ + ATTACH. ATTACH берёт
-- SHARE UPDATE EXCLUSIVE на родителя (PARTITION OF взял бы ACCESS EXCLUSIVE и встал бы в очередь
-- за каждым долгим запросом); CHECK границ избавляет ATTACH от проверочного скана. lock_timeout
-- 2 с — атрибутом функции (не утекает в транзакцию вызывающего): чужую долгую транзакцию не
-- ждём, вызывающий повторит с бэкоффом. Индексы родителя (в т.ч. BRIN) и внешние ключи ATTACH
-- создаёт на листе сам. Идемпотентна.
CREATE OR REPLACE FUNCTION lifecycle_ensure_partition(p_parent text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  spec lifecycle_partition_specs;
  sch  text := split_part(p_parent, '.', 1);
  tbl  text := split_part(p_parent, '.', 2);
  leaf text;
  lo   timestamptz;
  hi   timestamptz;
  sfx  text;
  blo  text;
  bhi  text;
  c    text;
  t    text;
BEGIN
  SELECT * INTO spec FROM lifecycle_partition_specs WHERE parent = p_parent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_ensure_partition: % is not a registered partitioned parent', p_parent;
  END IF;
  SELECT b.lo, b.hi, b.suffix INTO lo, hi, sfx FROM lifecycle_partition_bounds(spec.period, p_at) b;
  leaf := tbl || '_' || sfx;
  IF to_regclass(format('%I.%I', sch, leaf)) IS NOT NULL THEN
    RETURN leaf;
  END IF;
  -- Одно обслуживание родителя за раз во всём флоте (транзакционный замок — живёт до конца вызова)
  PERFORM pg_advisory_xact_lock(hashtext('lifecycle:partition:' || p_parent));
  IF to_regclass(format('%I.%I', sch, leaf)) IS NOT NULL THEN
    RETURN leaf;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_partitioned_table pt WHERE pt.partrelid = format('%I.%I', sch, tbl)::regclass AND pt.partdefid <> 0) THEN
    RAISE EXCEPTION 'lifecycle_ensure_partition: % has a DEFAULT partition — forbidden (it is scanned on every attach)', p_parent;
  END IF;
  blo := lifecycle_partition_literal(format('%I.%I', sch, tbl)::regclass, spec.column_name, lo);
  bhi := lifecycle_partition_literal(format('%I.%I', sch, tbl)::regclass, spec.column_name, hi);
  EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING GENERATED)', sch, leaf, sch, tbl);
  EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I >= %L AND %I < %L)', sch, leaf, leaf || '_bounds', spec.column_name, blo, spec.column_name, bhi);
  EXECUTE format('ALTER TABLE %I.%I ATTACH PARTITION %I.%I FOR VALUES FROM (%L) TO (%L)', sch, tbl, sch, leaf, blo, bhi);
  EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', sch, leaf, leaf || '_bounds');
  IF spec.insert_scale IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I SET (autovacuum_vacuum_insert_scale_factor = %s, autovacuum_analyze_scale_factor = %s)', sch, leaf, spec.insert_scale, spec.insert_scale);
  END IF;
  FOREACH c IN ARRAY coalesce(spec.lz4_columns, ARRAY[]::text[]) LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET COMPRESSION lz4', sch, leaf, c);
  END LOOP;
  -- Строковые триггеры родителя клонируются в лист при ATTACH, но состояние ENABLE ALWAYS — нет
  FOREACH t IN ARRAY coalesce(spec.always_triggers, ARRAY[]::text[]) LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER %I', sch, leaf, t);
  END LOOP;
  -- Лист можно TRUNCATE напрямую, минуя родителя, — свой запрет на уровне оператора
  IF spec.no_truncate_function IS NOT NULL THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %s()', tbl || '_no_truncate', sch, leaf, spec.no_truncate_function);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER %I', sch, leaf, tbl || '_no_truncate');
  END IF;
  RETURN leaf;
END;
$$;

-- Сбросить лист: пол срока, архив и заморозки проверяются ЗДЕСЬ (базой), не в коде приложения.
-- Граница — из каталога (relpartbound), не из имени листа. DETACH внутри функции — обычный
-- (CONCURRENTLY из функции невозможен): короткая блокировка родителя под lock_timeout 2 с,
-- вызывающий повторяет с бэкоффом, при неудаче — пропуск и метрика. Оборванный когда-то
-- `DETACH … CONCURRENTLY` («detach pending») доводится FINALIZE — иначе сброс вставал бы навсегда.
CREATE OR REPLACE FUNCTION lifecycle_drop_partition(p_parent text, p_leaf text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  spec    lifecycle_partition_specs;
  sch     text := split_part(p_parent, '.', 1);
  tbl     text := split_part(p_parent, '.', 2);
  bound   text;
  hi_txt  text;
  hi      timestamptz;
  att     boolean;
  pending boolean;
  arch    lifecycle_partition_archives;
  blocker uuid;
BEGIN
  SELECT * INTO spec FROM lifecycle_partition_specs WHERE parent = p_parent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is not a registered partitioned parent', p_parent;
  END IF;
  IF p_leaf !~ ('^' || tbl || '_[0-9]{4}_[0-9]{2}(_[0-9]{2})?$') THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is not a partition name of %', p_leaf, p_parent;
  END IF;
  IF to_regclass(format('%I.%I', sch, p_leaf)) IS NULL THEN
    RETURN false;
  END IF;
  SELECT pg_get_expr(c.relpartbound, c.oid), c.relispartition INTO bound, att
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = sch AND c.relname = p_leaf;
  IF att THEN
    SELECT i.inhdetachpending INTO pending FROM pg_inherits i
    WHERE i.inhrelid = format('%I.%I', sch, p_leaf)::regclass AND i.inhparent = format('%I.%I', sch, tbl)::regclass;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is not a partition of %', p_leaf, p_parent;
    END IF;
    hi_txt := substring(bound from 'TO \(''([^'']+)''\)');
    IF hi_txt IS NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: cannot read the bounds of %', p_leaf;
    END IF;
    -- timestamp без зоны — это UTC; timestamptz каталог печатает со смещением сессии
    hi := (hi_txt || CASE WHEN hi_txt ~ '[+-][0-9]{2}(:[0-9]{2})?$' THEN '' ELSE '+00' END)::timestamptz;
  ELSE
    -- Лист уже отсоединён (прерванный прошлый сброс): граница — из имени, дальше те же проверки
    SELECT b.hi INTO hi FROM lifecycle_partition_bounds(spec.period,
      (replace(substring(p_leaf from '_([0-9]{4}_[0-9]{2}(_[0-9]{2})?)$'), '_', '-') || CASE WHEN spec.period = 'month' THEN '-01' ELSE '' END || ' 00:00:00+00')::timestamptz) b;
  END IF;
  IF hi > now() - make_interval(days => spec.floor_days) THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is younger than the % day floor of %', p_leaf, spec.floor_days, p_parent;
  END IF;
  IF spec.require_archive THEN
    SELECT * INTO arch FROM lifecycle_partition_archives WHERE partition = sch || '.' || p_leaf;
    IF NOT FOUND OR arch.archived_at IS NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is not archived — refusing to drop', p_leaf;
    END IF;
  END IF;
  -- Заморозка: заморозка класса данных на всю платформу держит таблицу целиком; любая другая
  -- живая заморозка, способная задеть строки политики, требует отметки «строки извлечены»
  IF spec.hold_aware THEN
    SELECT h.id INTO blocker FROM lifecycle_holds h
    WHERE h.released_at IS NULL
      AND (
        (h.scope = 'class' AND h.data_class = spec.data_class AND h.workspace_id IS NULL)
        OR (
          ((h.scope = 'class' AND h.data_class = spec.data_class)
            OR h.scope IN ('custodian', 'space')
            OR (h.scope = 'record' AND h.record_type = spec.policy_id))
          AND NOT EXISTS (SELECT 1 FROM lifecycle_hold_extractions x WHERE x.hold_id = h.id AND x.partition = sch || '.' || p_leaf)
        )
      )
    LIMIT 1;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is under legal hold %', p_leaf, blocker;
    END IF;
  END IF;
  IF att THEN
    IF pending THEN
      EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I FINALIZE', sch, tbl, sch, p_leaf);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I', sch, tbl, sch, p_leaf);
    END IF;
  END IF;
  EXECUTE format('DROP TABLE %I.%I', sch, p_leaf);
  UPDATE lifecycle_partition_archives SET dropped_at = now() WHERE partition = sch || '.' || p_leaf;
  RETURN true;
END;
$$;

-- ANALYZE родителя: автовакуум партиционированных родителей не анализирует, а планировщик
-- берёт оценку по родителю. Только зарегистрированные родители — не «ANALYZE чего угодно».
CREATE OR REPLACE FUNCTION lifecycle_analyze_partitioned(p_parent text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lifecycle_partition_specs WHERE parent = p_parent) THEN
    RAISE EXCEPTION 'lifecycle_analyze_partitioned: % is not a registered partitioned parent', p_parent;
  END IF;
  EXECUTE format('ANALYZE %I.%I', split_part(p_parent, '.', 1), split_part(p_parent, '.', 2));
END;
$$;

-- Правила родителей. Пол — страховка от ошибочной настройки (UniSuper 2024): даже срок «0»
-- из кода не сбросит свежее пола; у политик с законным полом пол = закон (реестр `floorDays`,
-- сверяет verify-partitions). security_events — под своими функциями core/audit.
INSERT INTO "lifecycle_partition_specs" ("parent", "column_name", "period", "floor_days", "require_archive", "ahead_periods", "insert_scale", "lz4_columns", "always_triggers", "no_truncate_function", "policy_id", "data_class", "hold_aware") VALUES
  ('analytics.events', 'ts', 'month', 30, false, 3, 0.02, ARRAY[]::text[], ARRAY[]::text[], NULL, 'table:analytics.events', 'analytics_event', false),
  ('idem.responses', 'at', 'day', 1, false, 3, 0.05, ARRAY[]::text[], ARRAY[]::text[], NULL, 'table:idem.responses', 'derived', false),
  ('public.api_access_log', 'at', 'month', 30, false, 3, 0.02, ARRAY[]::text[], ARRAY[]::text[], NULL, 'ApiAccessLog', 'operational', false),
  ('public.notification_deliveries', 'created_at', 'month', 7, false, 3, 0.02, ARRAY[]::text[], ARRAY[]::text[], NULL, 'NotificationDelivery', 'operational', false),
  ('public.webhook_deliveries', 'created_at', 'month', 7, false, 3, 0.05, ARRAY['payload']::text[], ARRAY[]::text[], NULL, 'WebhookDelivery', 'operational', false),
  ('public.lifecycle_deleted_rows', 'deleted_at', 'day', 1, false, 3, 0.05, ARRAY[]::text[], ARRAY[]::text[], NULL, 'LifecycleDeletedRow', 'operational', false);

-- Листья учёта удалений: сегодня и два дня вперёд
SELECT lifecycle_ensure_partition('public.lifecycle_deleted_rows', now() + make_interval(days => i)) FROM generate_series(0, 2) AS i;

-- ============================================================
-- 3. notification_deliveries и webhook_deliveries → месячные RANGE-партиции
-- ============================================================
-- Доставка уведомления: created_at = момент СОБЫТИЯ (детерминирован) — уникум
-- (событие, получатель, канал, created_at) остаётся единственным между месяцами.
ALTER TABLE "notification_deliveries" RENAME TO "notification_deliveries_old";
ALTER TABLE "notification_deliveries_old" RENAME CONSTRAINT "notification_deliveries_pkey" TO "notification_deliveries_old_pkey";
ALTER TABLE "notification_deliveries_old" RENAME CONSTRAINT "notification_deliveries_event_id_fkey" TO "notification_deliveries_old_event_id_fkey";
ALTER INDEX "notification_deliveries_event_id_recipient_channel_key" RENAME TO "notification_deliveries_old_erc_key";
ALTER INDEX "notification_deliveries_user_id_channel_status_scheduled_at_idx" RENAME TO "notification_deliveries_old_ucss_idx";
ALTER INDEX "notification_deliveries_user_id_created_at_idx" RENAME TO "notification_deliveries_old_uc_idx";
ALTER INDEX "notification_deliveries_created_at_idx" RENAME TO "notification_deliveries_old_c_idx";

CREATE TABLE "notification_deliveries" (
    "id" BIGINT NOT NULL,
    "event_id" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "user_id" UUID,
    "channel" TEXT NOT NULL,
    "notification_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "provider_message_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
ALTER SEQUENCE "notification_deliveries_id_seq" OWNED BY "notification_deliveries"."id";
ALTER TABLE "notification_deliveries" ALTER COLUMN "id" SET DEFAULT nextval('notification_deliveries_id_seq');
CREATE UNIQUE INDEX "notification_deliveries_event_id_recipient_channel_created__key" ON "notification_deliveries"("event_id", "recipient", "channel", "created_at");
CREATE INDEX "notification_deliveries_user_id_channel_status_scheduled_at_idx" ON "notification_deliveries"("user_id", "channel", "status", "scheduled_at");
CREATE INDEX "notification_deliveries_user_id_created_at_idx" ON "notification_deliveries"("user_id", "created_at");
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries" USING BRIN ("created_at") WITH (pages_per_range = 64, autosummarize = on);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "notification_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

SELECT lifecycle_ensure_partition('public.notification_deliveries', m)
FROM (
  SELECT DISTINCT date_trunc('month', coalesce(e."created_at", d."created_at")) AT TIME ZONE 'UTC' AS m
  FROM "notification_deliveries_old" d LEFT JOIN "notification_events" e ON e."id" = d."event_id"
  UNION
  SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i)) AT TIME ZONE 'UTC' FROM generate_series(0, 2) AS i
) months;

INSERT INTO "notification_deliveries" ("id", "event_id", "recipient", "user_id", "channel", "notification_id", "status", "skip_reason", "provider_message_id", "error", "attempts", "scheduled_at", "sent_at", "created_at")
SELECT d."id", d."event_id", d."recipient", d."user_id", d."channel", d."notification_id", d."status", d."skip_reason", d."provider_message_id", d."error", d."attempts", d."scheduled_at", d."sent_at", coalesce(e."created_at", d."created_at")
FROM "notification_deliveries_old" d LEFT JOIN "notification_events" e ON e."id" = d."event_id";

ALTER SEQUENCE "notification_deliveries_id_seq" OWNED BY NONE;
DROP TABLE "notification_deliveries_old";
ALTER SEQUENCE "notification_deliveries_id_seq" OWNED BY "notification_deliveries"."id";

-- Вебхуки: id — UUIDv7 (подсказка времени из id), тело — lz4
ALTER TABLE "webhook_deliveries" RENAME TO "webhook_deliveries_old";
ALTER TABLE "webhook_deliveries_old" RENAME CONSTRAINT "webhook_deliveries_pkey" TO "webhook_deliveries_old_pkey";
ALTER TABLE "webhook_deliveries_old" RENAME CONSTRAINT "webhook_deliveries_endpoint_id_fkey" TO "webhook_deliveries_old_endpoint_id_fkey";
ALTER INDEX "webhook_deliveries_created_at_idx" RENAME TO "webhook_deliveries_old_c_idx";
ALTER INDEX "webhook_deliveries_status_next_at_idx" RENAME TO "webhook_deliveries_old_sn_idx";
ALTER INDEX "webhook_deliveries_endpoint_id_created_at_idx" RENAME TO "webhook_deliveries_old_ec_idx";

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "endpoint_id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMP(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
ALTER TABLE "webhook_deliveries" ALTER COLUMN "payload" SET COMPRESSION lz4;
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at" DESC);
CREATE INDEX "webhook_deliveries_status_next_at_idx" ON "webhook_deliveries"("status", "next_at");
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING BRIN ("created_at") WITH (pages_per_range = 64, autosummarize = on);
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

SELECT lifecycle_ensure_partition('public.webhook_deliveries', m)
FROM (
  SELECT DISTINCT date_trunc('month', "created_at") AT TIME ZONE 'UTC' AS m FROM "webhook_deliveries_old"
  UNION
  SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i)) AT TIME ZONE 'UTC' FROM generate_series(0, 2) AS i
) months;

INSERT INTO "webhook_deliveries" SELECT * FROM "webhook_deliveries_old";
DROP TABLE "webhook_deliveries_old";

-- Журнал обращений ключами: key_id — id ключа API (uuid), как и везде
ALTER TABLE "api_access_log" ALTER COLUMN "key_id" TYPE uuid USING "key_id"::uuid;

-- Родители под функциями владельца: у уже живых журналов — те же правила, листья вперёд
SELECT lifecycle_ensure_partition('public.api_access_log', (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i)) AT TIME ZONE 'UTC') FROM generate_series(0, 2) AS i;
SELECT lifecycle_ensure_partition('analytics.events', (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i)) AT TIME ZONE 'UTC') FROM generate_series(0, 2) AS i;
SELECT lifecycle_ensure_partition('idem.responses', now() + make_interval(days => i)) FROM generate_series(0, 2) AS i;

-- ============================================================
-- 4. Append-only: деньги и история владения
-- ============================================================
-- Леджер: проводка неизменна навсегда (исправление — встречная проводка). Удаления нет.
CREATE OR REPLACE FUNCTION lifecycle_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% is forbidden)', TG_TABLE_NAME, lower(TG_OP);
END;
$$;
CREATE TRIGGER "ledger_transfers_append_only" BEFORE UPDATE OR DELETE ON "ledger_transfers" FOR EACH ROW EXECUTE FUNCTION lifecycle_append_only();
ALTER TABLE "ledger_transfers" ENABLE ALWAYS TRIGGER "ledger_transfers_append_only";
CREATE TRIGGER "ledger_transfers_no_truncate" BEFORE TRUNCATE ON "ledger_transfers" FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_no_truncate();
ALTER TABLE "ledger_transfers" ENABLE ALWAYS TRIGGER "ledger_transfers_no_truncate";

-- История владения скинами и журнал изменений книги финансов: не меняются; строка уходит только
-- вместе со своим родителем (экземпляр скина / книга) — каскад и purge владельца
CREATE OR REPLACE FUNCTION lifecycle_append_only_with_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  alive boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only (update is forbidden)', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'card_skin_transfers' THEN
    SELECT EXISTS (SELECT 1 FROM "card_skin_instances" WHERE "id" = OLD."instance_id") INTO alive;
  ELSIF TG_TABLE_NAME = 'fin_audit_logs' THEN
    SELECT EXISTS (SELECT 1 FROM "fin_books" WHERE "id" = OLD."book_id") INTO alive;
  ELSE
    RAISE EXCEPTION 'lifecycle_append_only_with_parent: unexpected table %', TG_TABLE_NAME;
  END IF;
  IF alive THEN
    RAISE EXCEPTION '% is append-only while its parent lives (delete is forbidden)', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "card_skin_transfers_append_only" BEFORE UPDATE OR DELETE ON "card_skin_transfers" FOR EACH ROW EXECUTE FUNCTION lifecycle_append_only_with_parent();
ALTER TABLE "card_skin_transfers" ENABLE ALWAYS TRIGGER "card_skin_transfers_append_only";
CREATE TRIGGER "fin_audit_logs_append_only" BEFORE UPDATE OR DELETE ON "fin_audit_logs" FOR EACH ROW EXECUTE FUNCTION lifecycle_append_only_with_parent();
ALTER TABLE "fin_audit_logs" ENABLE ALWAYS TRIGGER "fin_audit_logs_append_only";

-- Эскроу — машина состояний: статус и ссылки проводок меняются, «личность» строки — нет
CREATE OR REPLACE FUNCTION lifecycle_escrow_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is a money record (delete is forbidden)', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'escrow_agreements' THEN
    IF (NEW."id", NEW."ref_type", NEW."ref_id", NEW."created_at") IS DISTINCT FROM (OLD."id", OLD."ref_type", OLD."ref_id", OLD."created_at") THEN
      RAISE EXCEPTION 'escrow_agreements: only the status may change';
    END IF;
  ELSE
    IF (NEW."id", NEW."agreement_id", NEW."currency_id", NEW."payer_user_id", NEW."beneficiary_user_id", NEW."created_at")
       IS DISTINCT FROM (OLD."id", OLD."agreement_id", OLD."currency_id", OLD."payer_user_id", OLD."beneficiary_user_id", OLD."created_at") THEN
      RAISE EXCEPTION 'escrow_holds: the parties and the agreement of a hold are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "escrow_agreements_guard" BEFORE UPDATE OR DELETE ON "escrow_agreements" FOR EACH ROW EXECUTE FUNCTION lifecycle_escrow_guard();
ALTER TABLE "escrow_agreements" ENABLE ALWAYS TRIGGER "escrow_agreements_guard";
CREATE TRIGGER "escrow_holds_guard" BEFORE UPDATE OR DELETE ON "escrow_holds" FOR EACH ROW EXECUTE FUNCTION lifecycle_escrow_guard();
ALTER TABLE "escrow_holds" ENABLE ALWAYS TRIGGER "escrow_holds_guard";

-- ============================================================
-- 5. Мягкое скрытие корневых сущностей и индексы раннера purge
-- ============================================================
ALTER TABLE "tasks" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "calendar_events" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "voice_recordings" ADD COLUMN "deleted_at" TIMESTAMP(3);
-- Частичные: корзина мала, живые строки индекс не раздувают
CREATE INDEX "tasks_deleted_at_idx" ON "tasks" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "calendar_events_deleted_at_idx" ON "calendar_events" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "voice_recordings_deleted_at_idx" ON "voice_recordings" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "sessions_revoked_at_idx" ON "sessions" ("revoked_at");
CREATE INDEX "platform_command_requests_created_at_idx" ON "platform_command_requests" ("created_at");

-- ============================================================
-- 6. Хранение
-- ============================================================
-- Очередь джобов: HOT-обновления статуса (fillfactor), автовакуум по порогу, а не по доле
ALTER TABLE "jobs" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 1000, autovacuum_vacuum_cost_delay = 0, autovacuum_analyze_scale_factor = 0.05);
-- Сессии: last_seen_at без индекса обновляется HOT'ом
ALTER TABLE "sessions" SET (fillfactor = 85);
-- Леджер: append-only — заморозка кортежей сразу (без волны anti-wraparound через годы), BRIN по времени
ALTER TABLE "ledger_transfers" SET (autovacuum_freeze_min_age = 0, autovacuum_vacuum_insert_scale_factor = 0.02);
CREATE INDEX "ledger_transfers_created_at_idx" ON "ledger_transfers" USING BRIN ("created_at") WITH (pages_per_range = 64, autosummarize = on);
-- Крупные JSON — lz4 (новые значения; старые перепишутся при изменении)
ALTER TABLE "notes" ALTER COLUMN "content" SET COMPRESSION lz4;
ALTER TABLE "process_versions" ALTER COLUMN "document" SET COMPRESSION lz4;
ALTER TABLE "process_versions" ALTER COLUMN "compiled" SET COMPRESSION lz4;
ALTER TABLE "consent_versions" ALTER COLUMN "bodies" SET COMPRESSION lz4;
ALTER TABLE "messages" ALTER COLUMN "payload" SET COMPRESSION lz4;
ALTER TABLE "notification_events" ALTER COLUMN "payload" SET COMPRESSION lz4;
