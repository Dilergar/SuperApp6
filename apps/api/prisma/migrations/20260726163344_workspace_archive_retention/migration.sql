-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "workspaces_archived_at_idx" ON "workspaces"("archived_at");

-- Бэкфилл: у деактивированных ДО этой миграции даты архивации нет. Берём updated_at —
-- единственный след момента, когда строку трогали в последний раз (деактивация как раз
-- была последней правкой). Без бэкфилла ретеншн-крон их бы не видел вовсе (archived_at
-- IS NULL), и они висели бы в архиве вечно.
UPDATE "workspaces" SET "archived_at" = "updated_at" WHERE "is_active" = false AND "archived_at" IS NULL;
