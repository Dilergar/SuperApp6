-- Журнал команд кабинета append-only: строковый триггер ловит UPDATE/DELETE, но
-- TRUNCATE строк не видит вовсе — он стирал бы вечный журнал одним оператором.
-- Отдельная функция, потому что statement-триггер не получает OLD/NEW.
CREATE OR REPLACE FUNCTION platform_audit_entries_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_entries is append-only (truncate is forbidden)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "platform_audit_entries_no_truncate" ON "platform_audit_entries";
CREATE TRIGGER "platform_audit_entries_no_truncate"
  BEFORE TRUNCATE ON "platform_audit_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_entries_no_truncate();
