-- Архитектура данных: идентификаторы в нативный uuid (16 байт вместо 36-символьного TEXT) и
-- UUIDv7 по умолчанию на стороне БАЗЫ (сырые INSERT тоже получают v7, часы одни).
-- СГЕНЕРИРОВАНО apps/api/scripts/gen-uuid-migration.cjs по schema.prisma (@db.Uuid) и живой базе.
-- Не-UUID значение в целевой колонке роняет миграцию целиком — данные чистятся ДО, не теряются молча.
SET lock_timeout = '3s';
SET statement_timeout = '600s';

-- 1. Внешние ключи, касающиеся колонок (0) — сброс

-- 2. Смена типа (1 колонок): одна ALTER TABLE на таблицу — одна перезапись
ALTER TABLE "notes"
  ALTER COLUMN "folder_path" DROP DEFAULT,
  ALTER COLUMN "folder_path" TYPE uuid[] USING "folder_path"::uuid[];

-- 3. Умолчания массивов — обратно, уже в uuid[]
ALTER TABLE "notes" ALTER COLUMN "folder_path" SET DEFAULT ARRAY[]::uuid[];

-- 4. Внешние ключи — обратно теми же определениями (0)
