-- core/lifecycle Э3: раннер сроков, loose FK (учёт удалений), каскад организации по реестру.
-- Прода ещё нет: индексы здесь — обычным CREATE INDEX. Со СЛЕДУЮЩЕЙ миграции действует страж
-- check:migrations (заголовок таймаутов; CREATE INDEX CONCURRENTLY — одна операция в файле;
-- онлайн-DDL горячих таблиц — scripts/db-online-ddl.cjs).
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ============================================================
-- 1. Loose FK: учёт удалённых строк родителей без внешних ключей у детей
-- ============================================================
-- Строка учёта, чьи дети под заморозкой, откладывается (воркер вернётся к ней позже)
ALTER TABLE "lifecycle_deleted_rows" ADD COLUMN "retry_at" TIMESTAMPTZ(3);
-- Очередь воркера: необработанные по порядку удаления
CREATE INDEX "lifecycle_deleted_rows_unprocessed_idx" ON "lifecycle_deleted_rows" ("deleted_at", "id") WHERE "processed_at" IS NULL;

-- Триггер уровня оператора с переходной таблицей: один INSERT на оператор, ловит и каскад FK,
-- и сырой DELETE. Аргумент — колонка организации строки ('' — её нет). Партиции дня нет
-- (крон не дошёл) — заводится функцией владельца и вставка повторяется: удаление человека не
-- должно падать из-за учёта.
CREATE OR REPLACE FUNCTION lifecycle_track_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  ws_col text := COALESCE(TG_ARGV[0], '');
BEGIN
  BEGIN
    IF ws_col = '' THEN
      INSERT INTO lifecycle_deleted_rows (table_name, row_id) SELECT TG_TABLE_NAME, o.id FROM old_rows o;
    ELSE
      EXECUTE format('INSERT INTO lifecycle_deleted_rows (table_name, row_id, workspace_id) SELECT %L, o.id, o.%I FROM old_rows o', TG_TABLE_NAME, ws_col);
    END IF;
  EXCEPTION WHEN check_violation THEN
    PERFORM lifecycle_ensure_partition('public.lifecycle_deleted_rows', clock_timestamp());
    IF ws_col = '' THEN
      INSERT INTO lifecycle_deleted_rows (table_name, row_id) SELECT TG_TABLE_NAME, o.id FROM old_rows o;
    ELSE
      EXECUTE format('INSERT INTO lifecycle_deleted_rows (table_name, row_id, workspace_id) SELECT %L, o.id, o.%I FROM old_rows o', TG_TABLE_NAME, ws_col);
    END IF;
  END;
  RETURN NULL;
END
$$;

-- Родители рёбер async_delete / async_nullify реестра (lifecycleLooseFkEdges; страж сверяет).
-- ENABLE ALWAYS: учёт не выключается session_replication_role (восстановление, репликация).
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "workspaces" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('id');
ALTER TABLE "workspaces" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "chats" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('workspace_id');
ALTER TABLE "chats" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "messages" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('');
ALTER TABLE "messages" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "tasks" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('workspace_id');
ALTER TABLE "tasks" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "notes" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('');
ALTER TABLE "notes" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "listings" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('');
ALTER TABLE "listings" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "fin_books" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('');
ALTER TABLE "fin_books" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "voice_recordings" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('');
ALTER TABLE "voice_recordings" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "staff_positions" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('workspace_id');
ALTER TABLE "staff_positions" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "staff_departments" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('workspace_id');
ALTER TABLE "staff_departments" ENABLE ALWAYS TRIGGER lifecycle_track_delete;
CREATE TRIGGER lifecycle_track_delete AFTER DELETE ON "staff_branches" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lifecycle_track_delete('workspace_id');
ALTER TABLE "staff_branches" ENABLE ALWAYS TRIGGER lifecycle_track_delete;

-- ============================================================
-- 2. Индексы: пачки каскада организации по workspace_id и ссылки детей loose FK
-- ============================================================
CREATE INDEX "search_documents_workspace_id_idx" ON "search_documents" ("workspace_id") WHERE "workspace_id" IS NOT NULL;
CREATE INDEX "call_sessions_workspace_id_idx" ON "call_sessions" ("workspace_id") WHERE "workspace_id" IS NOT NULL;
CREATE INDEX "call_recordings_workspace_id_idx" ON "call_recordings" ("workspace_id") WHERE "workspace_id" IS NOT NULL;
CREATE INDEX "notification_events_workspace_id_idx" ON "notification_events" ("workspace_id") WHERE "workspace_id" IS NOT NULL;
CREATE INDEX "resources_workspace_id_idx" ON "resources" ("workspace_id") WHERE "workspace_id" IS NOT NULL;
CREATE INDEX "analytics_rollup_session_day_workspace_id_day_idx" ON "analytics_rollup_session_day"("workspace_id", "day");
CREATE INDEX "keys_workspace_id_idx" ON "idem"."keys" ("workspace_id") WHERE "workspace_id" IS NOT NULL;
-- Корзины со своим сроком: закрытые офисные документы, удалённые операции финансов
CREATE INDEX "documents_archived_deleted_at_idx" ON "documents" ("deleted_at") WHERE "status" = 'archived';
CREATE INDEX "fin_transactions_deleted_at_idx" ON "fin_transactions" ("deleted_at") WHERE "deleted_at" IS NOT NULL;

-- ============================================================
-- 3. Бэкфилл: организация чатов (задача, заказ магазина организации, встреча офиса) и их проекций
-- ============================================================
UPDATE "chats" c SET "workspace_id" = t."workspace_id"
  FROM "tasks" t
 WHERE c."parent_type" = 'task' AND c."parent_id" = t."id" AND c."workspace_id" IS NULL AND t."workspace_id" IS NOT NULL;
UPDATE "chats" c SET "workspace_id" = r."workspace_id"
  FROM "office_rooms" r
 WHERE c."parent_type" = 'office_room' AND c."parent_id" = r."id" AND c."workspace_id" IS NULL;
UPDATE "chats" c SET "workspace_id" = s."owner_id"
  FROM "orders" o
  JOIN "listings" l ON l."id" = o."listing_id"
  JOIN "showcases" sc ON sc."id" = l."showcase_id"
  JOIN "shops" s ON s."id" = sc."shop_id"
 WHERE c."parent_type" = 'order' AND c."parent_id" = o."id" AND s."owner_type" = 'workspace' AND c."workspace_id" IS NULL;
UPDATE "search_documents" d SET "workspace_id" = c."workspace_id"
  FROM "chats" c
 WHERE d."chat_id" = c."id" AND d."workspace_id" IS NULL AND c."workspace_id" IS NOT NULL;
UPDATE "call_sessions" cs SET "workspace_id" = c."workspace_id"
  FROM "chats" c
 WHERE cs."ref_type" = 'chat' AND cs."ref_id" = c."id"::text AND cs."workspace_id" IS NULL AND c."workspace_id" IS NOT NULL;

-- ============================================================
-- 4. Офисные документы: момент конца жизни закрытых — от него срок шага docs.trash
-- ============================================================
UPDATE "documents" SET "deleted_at" = "updated_at" WHERE "status" = 'archived' AND "deleted_at" IS NULL;
