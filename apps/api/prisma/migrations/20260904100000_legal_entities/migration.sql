-- ============================================================
-- ЮРЛИЦА (LegalEntity) — из 1:1 «Реквизитов организации» в СПИСОК юрлиц.
-- Бренд-организация (Workspace) ≠ ТОО: сеть может держать несколько ТОО, объект и
-- трудовой договор ссылаются на конкретное. Существующая строка реквизитов
-- становится ГОЛОВНЫМ юрлицом (id и данные сохраняются — на них уже ссылаются
-- напечатанные документы), /requisites продолжает работать = головное.
-- ============================================================

-- ---------- 1. Переименование таблицы и колонок-новинок ----------
ALTER TABLE "workspace_requisites" RENAME TO "legal_entities";
ALTER TABLE "legal_entities" RENAME CONSTRAINT "workspace_requisites_pkey" TO "legal_entities_pkey";
ALTER TABLE "legal_entities" RENAME CONSTRAINT "workspace_requisites_workspace_id_fkey" TO "legal_entities_workspace_id_fkey";

ALTER TABLE "legal_entities" ADD COLUMN "name" TEXT;
ALTER TABLE "legal_entities" ADD COLUMN "is_head" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "legal_entities" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "legal_entities" ADD COLUMN "archived_at" TIMESTAMP(3);

-- Уникум 1:1 снимается — юрлиц у организации может быть много.
DROP INDEX IF EXISTS "workspace_requisites_workspace_id_key";

-- ---------- 2. Бэкфилл: существующая строка = головное юрлицо ----------
UPDATE "legal_entities" le
   SET "is_head" = true,
       "name" = COALESCE(NULLIF(TRIM(le."legal_name"), ''), w."name")
  FROM "workspaces" w
 WHERE w."id" = le."workspace_id";

-- Организации без реквизитов получают головное юрлицо с именем организации.
INSERT INTO "legal_entities" ("id", "workspace_id", "name", "is_head", "vat_payer", "created_at", "updated_at")
SELECT gen_random_uuid(), w."id", w."name", true, false, NOW(), NOW()
  FROM "workspaces" w
 WHERE NOT EXISTS (SELECT 1 FROM "legal_entities" le WHERE le."workspace_id" = w."id");

ALTER TABLE "legal_entities" ALTER COLUMN "name" SET NOT NULL;

CREATE INDEX "legal_entities_workspace_id_archived_at_idx" ON "legal_entities"("workspace_id", "archived_at");

-- ---------- 3. Счета принадлежат ЮРЛИЦУ, а не бренду ----------
ALTER TABLE "workspace_bank_accounts" ADD COLUMN "legal_entity_id" TEXT;

UPDATE "workspace_bank_accounts" a
   SET "legal_entity_id" = le."id"
  FROM "legal_entities" le
 WHERE le."workspace_id" = a."workspace_id" AND le."is_head";

-- Сирот (организация исчезла) быть не может — FK Cascade, но подстрахуемся.
DELETE FROM "workspace_bank_accounts" WHERE "legal_entity_id" IS NULL;

ALTER TABLE "workspace_bank_accounts" ALTER COLUMN "legal_entity_id" SET NOT NULL;
CREATE INDEX "workspace_bank_accounts_legal_entity_id_idx" ON "workspace_bank_accounts"("legal_entity_id");
ALTER TABLE "workspace_bank_accounts" ADD CONSTRAINT "workspace_bank_accounts_legal_entity_id_fkey"
  FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- 4. Трудовой договор заключает ЮРЛИЦО ----------
ALTER TABLE "hr_employments" ADD COLUMN "legal_entity_id" TEXT;
ALTER TABLE "hr_employments" ADD COLUMN "legal_entity_name" TEXT;

UPDATE "hr_employments" e
   SET "legal_entity_id" = le."id",
       "legal_entity_name" = le."name"
  FROM "legal_entities" le
 WHERE le."workspace_id" = e."workspace_id" AND le."is_head";

DELETE FROM "hr_employments" WHERE "legal_entity_id" IS NULL;

ALTER TABLE "hr_employments" ALTER COLUMN "legal_entity_id" SET NOT NULL;
CREATE INDEX "hr_employments_legal_entity_id_idx" ON "hr_employments"("legal_entity_id");
-- Restrict: юрлицо с трудовыми карточками не удаляется — только архивируется.
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_legal_entity_id_fkey"
  FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- РУКОПИСНЫЕ ОГРАНИЧЕНИЯ (Prisma их не выражает — зеркалятся комментами в schema.prisma).
-- ============================================================

-- Ровно одно ГОЛОВНОЕ юрлицо на организацию.
CREATE UNIQUE INDEX "legal_entities_head_per_workspace_key"
  ON "legal_entities"("workspace_id") WHERE "is_head";

-- БИН уникален среди живых юрлиц организации (архивные не мешают завести новое ТОО).
CREATE UNIQUE INDEX "legal_entities_bin_live_key"
  ON "legal_entities"("workspace_id", "bin")
  WHERE "bin" IS NOT NULL AND "archived_at" IS NULL;

-- Одна живая трудовая карточка на человека В КАЖДОМ юрлице (совместительство внутри
-- организации разрешено — это разные работодатели по договору).
DROP INDEX IF EXISTS "hr_employments_one_live";
CREATE UNIQUE INDEX "hr_employments_one_live"
  ON "hr_employments" ("workspace_id", "user_id", "legal_entity_id")
  WHERE "status" <> 'terminated';
