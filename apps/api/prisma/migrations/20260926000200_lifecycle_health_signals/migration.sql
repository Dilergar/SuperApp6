-- Сигналы здоровья раннера сроков (core/lifecycle) — одной функцией монитора.
--
-- Отставание реплик, VACUUM чужих процессов (автовакуум работает от суперпользователя) и
-- ожидания блокировок чужих сессий видны только роли с pg_read_all_stats. Дать её роли
-- приложения — открыть ей тексты запросов ВСЕХ сессий (pg_stat_activity.query: пароль в
-- ALTER ROLE администратора, чужие данные в литералах). Функция отдаёт ровно пять чисел
-- состояния кластера; db-roles.sql делает её владельцем NOLOGIN-роль sa6_monitor (только
-- pg_read_all_stats, без схем и таблиц), приложению — только EXECUTE. Таблицу функция
-- получает готовым oid (`to_regclass` считает ВЫЗЫВАЮЩИЙ со своими правами): поиска имён
-- внутри SECURITY DEFINER нет. Без db-roles.sql (dev) функция исполняется с правами
-- приложения: сигналы чужих процессов читаются нулём (fail-open — отказ в здоровье
-- остановил бы ретеншн навсегда, метрика отставания ретеншна — нет).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION lifecycle_health_signals(p_rel regclass)
RETURNS TABLE (lag float8, archiver_failing boolean, vacuum bigint, wal text, lock_waiters bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT
    (SELECT COALESCE(max(EXTRACT(EPOCH FROM replay_lag)), 0)::float8 FROM pg_stat_replication),
    (SELECT last_failed_time IS NOT NULL
            AND last_failed_time > COALESCE(last_archived_time, 'epoch'::timestamptz)
            AND last_failed_time > clock_timestamp() - interval '15 minutes'
       FROM pg_stat_archiver),
    (SELECT count(*) FROM pg_stat_progress_vacuum v WHERE p_rel IS NOT NULL AND v.relid = p_rel::oid),
    pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::text,
    (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock')
$$;
