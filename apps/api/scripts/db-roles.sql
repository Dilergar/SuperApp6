-- ============================================================
-- Роли БД журнала безопасности (core/audit) — ПРАВИЛО ДЕПЛОЯ (прод, стейдж)
-- ============================================================
-- Запуск (суперпользователем или владельцем БД), ПОСЛЕ `prisma migrate deploy`:
--
--   psql "$ADMIN_DATABASE_URL" -v app_role=superapp -f apps/api/scripts/db-roles.sql
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
