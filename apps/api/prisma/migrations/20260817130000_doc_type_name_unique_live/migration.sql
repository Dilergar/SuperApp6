-- «Одно имя вида на организацию» (среди ЖИВЫХ; архив имя отпускает).
--
-- Папка реестра на Диске ищется ПО ИМЕНИ вида (systemEnsureFolder → nameKey), и два
-- одноимённых вида делили одну папку: как только в неё попадал документ вида с
-- видимостью «команда», grantFolder открывал всей команде и уже лежащие там
-- документы вида «только управляющим». Реестр сервиса их по-прежнему прятал
-- (он фильтрует по docTypeId) — расхождение «список ≠ файлы», которое ловится
-- только глазами.
--
-- Дедуп на случай уже существующих совпадений (в текущих БД их нет — проверено):
-- второй и дальше по времени создания получают суффикс « (2)», « (3)»…
WITH dups AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id, lower(name) ORDER BY created_at, id) AS rn
  FROM doc_types
  WHERE archived_at IS NULL
)
UPDATE doc_types t
SET name = t.name || ' (' || d.rn || ')'
FROM dups d
WHERE d.id = t.id AND d.rn > 1;

-- РУКАМИ (Prisma не выражает функциональный партиальный UNIQUE; зеркало-коммент
-- в schema.prisma у модели DocType). lower() — потому что и папка Диска ключуется
-- регистронезависимо: «Договор» и «договор» — одна папка.
CREATE UNIQUE INDEX "doc_types_workspace_name_live"
  ON "doc_types" ("workspace_id", lower("name"))
  WHERE "archived_at" IS NULL;
