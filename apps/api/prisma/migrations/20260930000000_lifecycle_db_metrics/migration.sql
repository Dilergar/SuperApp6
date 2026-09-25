SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Сторожевые метрики БД (core/lifecycle Э7, docs/data_architecture.md «Наблюдаемость»): числа
-- сверх сводки дашборда `lifecycle_db_overview()` — кэш-попадания, временные файлы, дедлоки,
-- доля запрошенных чекпойнтов, удержание WAL слотами и его потолок, архиватор WAL, самая
-- долгая транзакция, самый старый relfrozenxid. Только ЧИСЛА (ни текста запросов, ни имён
-- пользователей); db-roles.sql отдаёт функцию во владение sa6_monitor (pg_read_all_stats живёт
-- у неё), приложению — только EXECUTE. Без db-roles.sql (dev) — права приложения.
CREATE OR REPLACE FUNCTION lifecycle_db_metrics()
RETURNS TABLE (
  cache_hit_ratio float8,
  temp_files bigint,
  temp_bytes bigint,
  deadlocks bigint,
  checkpoints_timed bigint,
  checkpoints_requested bigint,
  slot_retained_wal_bytes bigint,
  slots_inactive integer,
  slot_wal_cap_bytes bigint,
  archive_failed bigint,
  archive_last_success timestamptz,
  archive_last_failure timestamptz,
  longest_tx_seconds float8,
  oldest_relfrozenxid_age bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT
    (SELECT CASE WHEN d.blks_hit + d.blks_read = 0 THEN 1 ELSE d.blks_hit::float8 / (d.blks_hit + d.blks_read) END
       FROM pg_stat_database d WHERE d.datname = current_database()),
    (SELECT d.temp_files FROM pg_stat_database d WHERE d.datname = current_database()),
    (SELECT d.temp_bytes FROM pg_stat_database d WHERE d.datname = current_database()),
    (SELECT d.deadlocks FROM pg_stat_database d WHERE d.datname = current_database()),
    (SELECT c.num_timed FROM pg_stat_checkpointer c),
    (SELECT c.num_requested FROM pg_stat_checkpointer c),
    (SELECT COALESCE(max(pg_wal_lsn_diff(
        CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END, s.restart_lsn)), 0)::bigint
       FROM pg_replication_slots s WHERE s.restart_lsn IS NOT NULL),
    (SELECT count(*)::int FROM pg_replication_slots s WHERE NOT s.active),
    -- max_slot_wal_keep_size в МБ; -1 = без потолка
    (SELECT CASE WHEN st.setting::bigint < 0 THEN -1 ELSE st.setting::bigint * 1024 * 1024 END
       FROM pg_settings st WHERE st.name = 'max_slot_wal_keep_size'),
    (SELECT a.failed_count FROM pg_stat_archiver a),
    (SELECT a.last_archived_time FROM pg_stat_archiver a),
    (SELECT a.last_failed_time FROM pg_stat_archiver a),
    (SELECT COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - p.xact_start))), 0)::float8
       FROM pg_stat_activity p
      WHERE p.datname = current_database() AND p.backend_type = 'client backend' AND p.xact_start IS NOT NULL),
    (SELECT COALESCE(max(age(c.relfrozenxid)), 0)::bigint
       FROM pg_class c WHERE c.relkind IN ('r', 'm', 't') AND c.relfrozenxid <> '0'::xid)
$$;
