SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- core/lifecycle Э5: таймер автоудаления сообщений в чате, суточные снимки размеров по классам
-- данных, пауза и срок политики командой Кабинета, идемпотентные отчёты бэкапов, сводка
-- кластера для дашборда «Данные».

-- ---- Таймер чата (политика Message: userConfigurable) ----
-- Новые колонки без DEFAULT — метаданные, без перезаписи таблицы. CHECK сначала NOT VALID
-- (без скана под замком), затем VALIDATE (SHARE UPDATE EXCLUSIVE: чтение и запись идут).
ALTER TABLE "chats"
  ADD COLUMN "message_ttl_days" INTEGER,
  ADD COLUMN "message_ttl_set_by_id" UUID,
  ADD COLUMN "message_ttl_set_at" TIMESTAMPTZ(3);
ALTER TABLE "chats" ADD CONSTRAINT "chats_message_ttl_days_check"
  CHECK ("message_ttl_days" IS NULL OR "message_ttl_days" IN (1, 7, 30)) NOT VALID;
ALTER TABLE "chats" VALIDATE CONSTRAINT "chats_message_ttl_days_check";

-- ---- Суточный снимок размеров по классам данных (рост хранилища за 90 дней) ----
CREATE TABLE "lifecycle_storage_daily" (
    "day" DATE NOT NULL,
    "data_class" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "rows" BIGINT NOT NULL,
    "tables" INTEGER NOT NULL,
    CONSTRAINT "lifecycle_storage_daily_pkey" PRIMARY KEY ("day", "data_class")
);

-- ---- Пауза и срок политики командой Кабинета (раннер читает на каждом прогоне) ----
CREATE TABLE "lifecycle_policy_overrides" (
    "policy_id" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "days" INTEGER,
    "reason" TEXT NOT NULL,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "lifecycle_policy_overrides_pkey" PRIMARY KEY ("policy_id"),
    CONSTRAINT "lifecycle_policy_overrides_days_check" CHECK ("days" IS NULL OR "days" > 0)
);

-- ---- Отчёт бэкапа идемпотентен по метке прогона (pgBackRest label, id учения) ----
ALTER TABLE "lifecycle_backup_runs" ADD COLUMN "external_id" TEXT;
CREATE UNIQUE INDEX "lifecycle_backup_runs_kind_repo_external_id_key" ON "lifecycle_backup_runs" ("kind", "repo", "external_id");

-- ---- Сводка кластера для дашборда «Данные» ----
-- Как lifecycle_health_signals: чужие сессии, ожидания и возраст XID видны только роли с
-- pg_read_all_stats. Функция отдаёт ЧИСЛА (ни текста запросов, ни имён пользователей);
-- db-roles.sql отдаёт её во владение sa6_monitor, приложению — только EXECUTE. Без
-- db-roles.sql (dev) она исполняется с правами приложения: счётчики чужих процессов — нулём.
CREATE OR REPLACE FUNCTION lifecycle_db_overview()
RETURNS TABLE (
  xid_age bigint,
  mxid_age bigint,
  db_bytes bigint,
  connections integer,
  connections_active integer,
  connections_idle_tx integer,
  max_connections integer,
  lock_waiters integer,
  lwlock_lockmanager integer,
  replicas integer,
  max_replay_lag float8,
  invalid_indexes integer,
  detach_pending integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT
    (SELECT age(datfrozenxid)::bigint FROM pg_database WHERE datname = current_database()),
    (SELECT mxid_age(datminmxid)::bigint FROM pg_database WHERE datname = current_database()),
    pg_database_size(current_database()),
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'),
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND state = 'active'),
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'),
    current_setting('max_connections')::int,
    (SELECT count(*)::int FROM pg_stat_activity WHERE wait_event_type = 'Lock'),
    (SELECT count(*)::int FROM pg_stat_activity WHERE wait_event_type = 'LWLock' AND wait_event = 'LockManager'),
    (SELECT count(*)::int FROM pg_stat_replication),
    (SELECT COALESCE(max(EXTRACT(EPOCH FROM replay_lag)), 0)::float8 FROM pg_stat_replication),
    (SELECT count(*)::int FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
    (SELECT count(*)::int FROM pg_inherits WHERE inhdetachpending)
$$;
