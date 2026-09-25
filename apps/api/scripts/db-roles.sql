-- ============================================================
-- Роли БД: журнал безопасности (core/audit) и данные (core/lifecycle) — ПРАВИЛО ДЕПЛОЯ
-- ============================================================
-- Запуск (суперпользователем), ПОСЛЕ `prisma migrate deploy`:
--
--   psql "$ADMIN_DATABASE_URL" -v app_role=superapp -f apps/api/scripts/db-roles.sql
--
-- Часть 1 — журнал безопасности. Часть 2 (ниже) — владелец данных `sa6_data_owner`,
-- роли миграций/чтения/бэкапа и событийный триггер против DROP защищённых таблиц.
--
-- Зачем. Append-only журнала держат ДВА слоя:
--   1) триггеры `*_guard` (ENABLE ALWAYS) — в миграции `core_audit`, работают везде;
--   2) ПРАВА — этот файл: владелец журнала `sa6_audit_owner` (NOLOGIN) ≠ роль приложения.
--      Роль приложения не владелец → не может `ALTER TABLE … DISABLE TRIGGER`, `DROP`,
--      `DETACH`; `DELETE`/`TRUNCATE` у неё отозваны; `UPDATE` — ТОЛЬКО колонки шифротекста
--      (перешивка `keys.rewrap` после ротации платформенного KEK). Партиции создаёт и
--      сбрасывает SECURITY DEFINER-функция владельца (`audit_ensure_partition`,
--      `audit_drop_partition` — последняя требует архив и возраст ≥ 3 лет).
--   ЕТ № 832 п. 38: «не допускается наличие у системных администраторов полномочий на
--   изменение, удаление и отключение журналов» — админ приложения работает ролью приложения.
--
-- Идемпотентен: повторный запуск безопасен (новые партиции уже принадлежат владельцу —
-- их создаёт функция владельца).
-- ============================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sa6_audit_owner') THEN
    CREATE ROLE sa6_audit_owner NOLOGIN;
  END IF;
END $$;
-- Владелец создаёт партиции функцией `audit_ensure_partition` — ему нужен CREATE в схеме.
-- Будущие миграции, меняющие таблицы журнала, запускаются ролью-админом (не ролью приложения).
GRANT USAGE, CREATE ON SCHEMA public TO sa6_audit_owner;

-- ---- Владение: журнал, его партиции, дайджесты, архив, квитанции, функции ----
ALTER TABLE "security_events" OWNER TO sa6_audit_owner;
ALTER SEQUENCE "security_events_id_seq" OWNER TO sa6_audit_owner;
DO $$
DECLARE
  part text;
BEGIN
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'security_events'
  LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO sa6_audit_owner', part);
  END LOOP;
END $$;
ALTER TABLE "security_digests" OWNER TO sa6_audit_owner;
ALTER TABLE "security_partition_archives" OWNER TO sa6_audit_owner;
ALTER TABLE "platform_command_receipts" OWNER TO sa6_audit_owner;
ALTER FUNCTION audit_ensure_partition(date) OWNER TO sa6_audit_owner;
ALTER FUNCTION audit_drop_partition(text) OWNER TO sa6_audit_owner;
ALTER FUNCTION security_events_guard() OWNER TO sa6_audit_owner;
ALTER FUNCTION security_events_no_truncate() OWNER TO sa6_audit_owner;
ALTER FUNCTION security_digests_guard() OWNER TO sa6_audit_owner;
ALTER FUNCTION security_partition_archives_guard() OWNER TO sa6_audit_owner;
ALTER FUNCTION platform_command_receipts_guard() OWNER TO sa6_audit_owner;

-- ---- Роль приложения: читать и дописывать, но не менять и не удалять ----
REVOKE ALL ON "security_events" FROM :"app_role";
GRANT SELECT, INSERT ON "security_events" TO :"app_role";
GRANT UPDATE ("ip_enc", "ua_raw_enc") ON "security_events" TO :"app_role";
GRANT USAGE, SELECT ON SEQUENCE "security_events_id_seq" TO :"app_role";

REVOKE ALL ON "security_digests" FROM :"app_role";
GRANT SELECT, INSERT ON "security_digests" TO :"app_role";
GRANT UPDATE ("exported_at", "verified_at", "verify_ok") ON "security_digests" TO :"app_role";

REVOKE ALL ON "security_partition_archives" FROM :"app_role";
GRANT SELECT, INSERT ON "security_partition_archives" TO :"app_role";

REVOKE ALL ON "platform_command_receipts" FROM :"app_role";
GRANT SELECT, INSERT ON "platform_command_receipts" TO :"app_role";

REVOKE ALL ON FUNCTION audit_ensure_partition(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_drop_partition(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_ensure_partition(date) TO :"app_role";
GRANT EXECUTE ON FUNCTION audit_drop_partition(text) TO :"app_role";

-- ---- Самопроверка: роль приложения не владеет ничем из журнала ----
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
  WHERE (c.relname = 'security_events' OR c.relname LIKE 'security_events\_%' OR c.relname IN ('security_digests', 'security_partition_archives', 'platform_command_receipts'))
    AND c.relkind IN ('r', 'p') AND r.rolname <> 'sa6_audit_owner';
  IF bad > 0 THEN
    RAISE EXCEPTION 'db-roles: % audit relation(s) are not owned by sa6_audit_owner', bad;
  END IF;
END $$;

-- ============================================================
-- Часть 2. Данные (core/lifecycle): владелец данных и роли эксплуатации
-- ============================================================
-- sa6_data_owner (NOLOGIN) — владелец партиционированных журналов (родители + листья),
--   append-only денег (леджер, эскроу, история скинов, журнал книги финансов) и таблиц движка
--   жизненного цикла (заморозки, журнал стираний, правила и архивы партиций). Листья создаёт и
--   сбрасывает ТОЛЬКО SECURITY DEFINER-функция владельца (`lifecycle_ensure_partition`,
--   `lifecycle_drop_partition` — пол срока, архив, заморозки, необработанная очередь
--   проверяются базой). Роль приложения не владелец → ни DROP, ни DETACH, ни ALTER.
-- sa6_migrate — роль миграций (DIRECT_URL, мимо пулера); член sa6_data_owner: ALTER таблиц
--   владельца можно, а DROP защищённой таблицы режет событийный триггер (ниже) — удалить её
--   можно только осознанно, `SET ROLE sa6_data_owner`.
-- sa6_readonly — чтение для поддержки и отчётов (pg_read_all_data, без записи).
-- sa6_backup — pgBackRest и логические выгрузки (чтение + функции резервного копирования).
-- sa6_monitor — владелец функций-сводок `lifecycle_health_signals` (сигналы здоровья раннера
--   сроков) и `lifecycle_db_overview` (дашборд «Данные»): pg_read_all_stats живёт у неё, а не
--   у роли приложения — иначе приложению видны тексты запросов всех сессий
--   (pg_stat_activity.query). Приложению — только EXECUTE.
-- Все роли создаются NOLOGIN: вход и пароль выдаёт эксплуатация из хранилища секретов
-- (`ALTER ROLE … LOGIN PASSWORD …`) — секретов в этом файле нет.
-- Аварийный выход (суперпользователь): `ALTER EVENT TRIGGER lifecycle_guard_drop DISABLE`.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['sa6_data_owner', 'sa6_migrate', 'sa6_readonly', 'sa6_backup', 'sa6_monitor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

GRANT USAGE, CREATE ON SCHEMA public, analytics, idem TO sa6_data_owner;
GRANT sa6_data_owner TO sa6_migrate;
GRANT USAGE, CREATE ON SCHEMA public, analytics, idem TO sa6_migrate;
-- Лист с внешним ключом клонирует FK при ATTACH — владельцу нужен REFERENCES на цель
GRANT REFERENCES ON "notification_events", "webhook_endpoints" TO sa6_data_owner;
GRANT pg_read_all_data TO sa6_readonly;
GRANT pg_read_all_data, pg_read_all_settings, pg_checkpoint TO sa6_backup;
ALTER ROLE sa6_backup REPLICATION;
GRANT EXECUTE ON FUNCTION pg_backup_start(text, boolean), pg_backup_stop(boolean), pg_create_restore_point(text), pg_switch_wal() TO sa6_backup;
GRANT pg_read_all_stats TO sa6_monitor;

-- Роль приложения — в настройку сессии: DO-блок не видит переменных psql
SELECT set_config('sa6.app_role', :'app_role', false);

-- ---- Владение: партиционированные журналы (родители + листья) ----
DO $$
DECLARE
  s record;
  leaf record;
  app text := current_setting('sa6.app_role');
BEGIN
  FOR s IN SELECT parent FROM lifecycle_partition_specs LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO sa6_data_owner', split_part(s.parent, '.', 1), split_part(s.parent, '.', 2));
    FOR leaf IN
      SELECT n.nspname, c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.inhparent = format('%I.%I', split_part(s.parent, '.', 1), split_part(s.parent, '.', 2))::regclass
    LOOP
      EXECUTE format('ALTER TABLE %I.%I OWNER TO sa6_data_owner', leaf.nspname, leaf.relname);
      EXECUTE format('GRANT SELECT ON %I.%I TO %I', leaf.nspname, leaf.relname, app);
    END LOOP;
    -- Роль приложения пишет и читает ЧЕРЕЗ родителя; DDL у неё нет
    EXECUTE format('REVOKE ALL ON %I.%I FROM %I', split_part(s.parent, '.', 1), split_part(s.parent, '.', 2), app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I', split_part(s.parent, '.', 1), split_part(s.parent, '.', 2), app);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE "notification_deliveries_id_seq", "api_access_log_id_seq", "lifecycle_deleted_rows_id_seq", idem."responses_id_seq" TO :"app_role";
-- Новые листья (их создаёт функция владельца): чтение напрямую — роли приложения
-- (аналитика читает минимум листа), запись — только через родителя
ALTER DEFAULT PRIVILEGES FOR ROLE sa6_data_owner IN SCHEMA public, analytics, idem GRANT SELECT ON TABLES TO :"app_role";

-- ---- Владение: деньги и история владения (append-only — триггеры миграции core_lifecycle) ----
ALTER TABLE "ledger_transfers" OWNER TO sa6_data_owner;
ALTER TABLE "escrow_agreements" OWNER TO sa6_data_owner;
ALTER TABLE "escrow_holds" OWNER TO sa6_data_owner;
ALTER TABLE "card_skin_transfers" OWNER TO sa6_data_owner;
ALTER TABLE "fin_audit_logs" OWNER TO sa6_data_owner;
REVOKE ALL ON "ledger_transfers", "escrow_agreements", "escrow_holds", "card_skin_transfers", "fin_audit_logs" FROM :"app_role";
GRANT SELECT, INSERT ON "ledger_transfers" TO :"app_role";
GRANT USAGE, SELECT ON SEQUENCE "ledger_transfers_id_seq" TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON "escrow_agreements", "escrow_holds" TO :"app_role";
-- Удаление строки истории — только вместе с родителем (триггер); каскад FK идёт от владельца
GRANT SELECT, INSERT, DELETE ON "card_skin_transfers", "fin_audit_logs" TO :"app_role";
GRANT USAGE, SELECT ON SEQUENCE "card_skin_transfers_id_seq" TO :"app_role";
-- Каскад FK (экземпляр скина → его история) PostgreSQL исполняет ОТ ВЛАДЕЛЬЦА дочерней
-- таблицы, и триггер append-only спрашивает «жив ли родитель» тоже от его имени: без права
-- на колонку id родителя любое удаление экземпляра (стирание аккаунта, каскад организации)
-- падает 42501. Владельцу — только id родителей: сами строки ему не нужны.
GRANT SELECT ("id") ON "card_skin_instances", "fin_books" TO sa6_data_owner;

-- ---- Владение: таблицы движка жизненного цикла, где право на удаление = подлог ----
ALTER TABLE "lifecycle_holds" OWNER TO sa6_data_owner;
ALTER TABLE "lifecycle_erasure_journal" OWNER TO sa6_data_owner;
ALTER TABLE "lifecycle_hold_store" OWNER TO sa6_data_owner;
ALTER TABLE "lifecycle_hold_extractions" OWNER TO sa6_data_owner;
ALTER TABLE "lifecycle_partition_specs" OWNER TO sa6_data_owner;
ALTER TABLE "lifecycle_partition_archives" OWNER TO sa6_data_owner;
REVOKE ALL ON "lifecycle_holds", "lifecycle_erasure_journal", "lifecycle_hold_store", "lifecycle_hold_extractions", "lifecycle_partition_specs", "lifecycle_partition_archives" FROM :"app_role";
GRANT SELECT, INSERT, UPDATE ON "lifecycle_holds" TO :"app_role";
GRANT SELECT, INSERT ON "lifecycle_erasure_journal" TO :"app_role";
GRANT UPDATE ("exported_at") ON "lifecycle_erasure_journal" TO :"app_role";
GRANT USAGE, SELECT ON SEQUENCE "lifecycle_erasure_journal_id_seq" TO :"app_role";
GRANT SELECT, INSERT, DELETE ON "lifecycle_hold_store", "lifecycle_hold_extractions" TO :"app_role";
GRANT USAGE, SELECT ON SEQUENCE "lifecycle_hold_store_id_seq" TO :"app_role";
GRANT SELECT, INSERT ON "lifecycle_partition_archives" TO :"app_role";
-- Правила партиций читают все (их читает и событийный триггер под ролью любой команды)
GRANT SELECT ON "lifecycle_partition_specs" TO PUBLIC;

-- ---- Функции владельца ----
ALTER FUNCTION lifecycle_partition_bounds(text, timestamptz) OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_partition_literal(regclass, text, timestamptz) OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_ensure_partition(text, timestamptz) OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_drop_partition(text, text) OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_analyze_partitioned(text) OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_holds_guard() OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_erasure_journal_guard() OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_no_truncate() OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_append_only() OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_append_only_with_parent() OWNER TO sa6_data_owner;
ALTER FUNCTION lifecycle_escrow_guard() OWNER TO sa6_data_owner;
REVOKE ALL ON FUNCTION lifecycle_ensure_partition(text, timestamptz), lifecycle_drop_partition(text, text), lifecycle_analyze_partitioned(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_ensure_partition(text, timestamptz), lifecycle_drop_partition(text, text), lifecycle_analyze_partitioned(text) TO :"app_role";
-- Сигналы здоровья раннера: SECURITY DEFINER под монитором (pg_read_all_stats) — наружу пять чисел
ALTER FUNCTION lifecycle_health_signals(regclass) OWNER TO sa6_monitor;
REVOKE ALL ON FUNCTION lifecycle_health_signals(regclass) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_health_signals(regclass) TO :"app_role";
-- Сводка кластера дашборда «Данные» (Э5): тот же приём — наружу только числа
ALTER FUNCTION lifecycle_db_overview() OWNER TO sa6_monitor;
REVOKE ALL ON FUNCTION lifecycle_db_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_db_overview() TO :"app_role";
-- Сторожевые метрики (Э7): кэш, временные файлы, чекпойнты, слоты WAL, архиватор — числа
ALTER FUNCTION lifecycle_db_metrics() OWNER TO sa6_monitor;
REVOKE ALL ON FUNCTION lifecycle_db_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_db_metrics() TO :"app_role";

-- ---- Событийный триггер: DROP защищённой таблицы — только роли владельца ----
-- Срабатывает на sql_drop (DROP TABLE, DROP SCHEMA … CASCADE, DROP OWNED, DROP COLUMN) ДО
-- коммита: исключение откатывает команду. Функции владельца исполняются от его имени
-- (current_user = sa6_data_owner / sa6_audit_owner) и проходят; миграция, скрипт или
-- человек под другой ролью — нет. TRUNCATE событием не является — его режут построчные
-- стражи и BEFORE TRUNCATE-триггеры миграций.
CREATE OR REPLACE FUNCTION lifecycle_guard_drop() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  obj record;
  sch text;
  tbl text;
BEGIN
  IF current_user IN ('sa6_data_owner', 'sa6_audit_owner') THEN
    RETURN;
  END IF;
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() WHERE object_type IN ('table', 'table column') LOOP
    sch := obj.address_names[1];
    tbl := obj.address_names[2];
    IF sch IS NULL OR tbl IS NULL THEN
      CONTINUE;
    END IF;
    IF (sch = 'public' AND (tbl IN ('security_events', 'security_digests', 'security_partition_archives', 'platform_command_receipts',
                                    'ledger_transfers', 'escrow_agreements', 'escrow_holds', 'card_skin_transfers', 'fin_audit_logs',
                                    'lifecycle_holds', 'lifecycle_erasure_journal', 'lifecycle_hold_store', 'lifecycle_hold_extractions',
                                    'lifecycle_partition_specs', 'lifecycle_partition_archives')
                            OR tbl ~ '^security_events_[0-9]{4}_[0-9]{2}$'))
       OR EXISTS (
         SELECT 1 FROM lifecycle_partition_specs s
         WHERE split_part(s.parent, '.', 1) = sch
           AND (split_part(s.parent, '.', 2) = tbl OR tbl ~ ('^' || split_part(s.parent, '.', 2) || '_[0-9]{4}_[0-9]{2}(_[0-9]{2})?$'))
       )
    THEN
      RAISE EXCEPTION 'lifecycle: % of protected table %.% is allowed only to the data owner (owner functions)', obj.object_type, sch, tbl
        USING HINT = 'Partitions are dropped by lifecycle_drop_partition(); a deliberate drop needs SET ROLE sa6_data_owner';
    END IF;
  END LOOP;
END;
$$;
DROP EVENT TRIGGER IF EXISTS lifecycle_guard_drop;
CREATE EVENT TRIGGER lifecycle_guard_drop ON sql_drop EXECUTE FUNCTION lifecycle_guard_drop();

-- ---- Самопроверка: защищённое принадлежит владельцу данных ----
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
  WHERE c.relkind IN ('r', 'p') AND r.rolname <> 'sa6_data_owner'
    AND (
      (n.nspname = 'public' AND c.relname IN ('ledger_transfers', 'escrow_agreements', 'escrow_holds', 'card_skin_transfers', 'fin_audit_logs',
                                              'lifecycle_holds', 'lifecycle_erasure_journal', 'lifecycle_hold_store', 'lifecycle_hold_extractions',
                                              'lifecycle_partition_specs', 'lifecycle_partition_archives'))
      OR EXISTS (SELECT 1 FROM lifecycle_partition_specs s
                 WHERE split_part(s.parent, '.', 1) = n.nspname
                   AND (split_part(s.parent, '.', 2) = c.relname OR c.relname ~ ('^' || split_part(s.parent, '.', 2) || '_[0-9]{4}_[0-9]{2}(_[0-9]{2})?$')))
    );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'db-roles: not owned by sa6_data_owner: %', bad;
  END IF;
END $$;

-- ============================================================
-- Часть 3. Потолки ролей и вход пулера (docs/data_architecture.md)
-- ============================================================
-- Потолки — на РОЛИ, не глобально: миграции (sa6_migrate, заголовок SET в файле), бэкап и
-- обслуживающее подключение приложения (параметры запуска `options` старше ALTER ROLE SET:
-- REINDEX CONCURRENTLY очереди, суточный роллап) живут со своими. Долгое законное внутри
-- транзакции поднимает `SET LOCAL statement_timeout` само (запросы Кабинета, раннер сроков).
ALTER ROLE :"app_role" SET statement_timeout = '30s';
ALTER ROLE :"app_role" SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE :"app_role" SET transaction_timeout = '5min';
-- Отчёты и поддержка: только чтение, короткий потолок (тяжёлое — на отчётную реплику)
ALTER ROLE sa6_readonly SET statement_timeout = '5s';
ALTER ROLE sa6_readonly SET default_transaction_read_only = on;

-- ---- PgBouncer: пароли в пулере не хранятся (auth_query) ----
-- Пулер входит ролью sa6_pgbouncer_auth (единственная строка его userlist) и спрашивает хеш
-- SCRAM входящей роли у SECURITY DEFINER-функции. Через пулер не входят: суперпользователи,
-- роли миграций и бэкапа (они ходят по DIRECT_URL), роли с REPLICATION, сам sa6_pgbouncer_auth.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sa6_pgbouncer_auth') THEN
    CREATE ROLE sa6_pgbouncer_auth NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS pgbouncer;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO sa6_pgbouncer_auth;
CREATE OR REPLACE FUNCTION pgbouncer.get_auth(p_usename text)
RETURNS TABLE (usename name, passwd text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.usename, s.passwd
    FROM pg_catalog.pg_shadow s
    JOIN pg_catalog.pg_roles r ON r.rolname = s.usename
   WHERE s.usename = p_usename
     AND NOT r.rolsuper AND NOT r.rolreplication AND r.rolcanlogin
     AND s.usename NOT IN ('sa6_pgbouncer_auth', 'sa6_migrate', 'sa6_backup')
$$;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO sa6_pgbouncer_auth;
