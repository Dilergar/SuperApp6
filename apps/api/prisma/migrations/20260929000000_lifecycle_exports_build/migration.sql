SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Выгрузки (core/lifecycle Э6): вид архива (переносимый человеку и организации / восстановление
-- арендатора), строк в архиве, ход сборки по фазам (сбор → упаковка частей → манифест),
-- момент данных источника (восстановление — время снимка после PITR), число заходов сборки и
-- опции заявки (дев-подсадка чужой строки для стража владельца — только разработка).
ALTER TABLE "lifecycle_exports"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'portable',
  ADD COLUMN "rows" INTEGER,
  ADD COLUMN "progress" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "options" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "snapshot_at" TIMESTAMPTZ(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "lifecycle_exports"
  ADD CONSTRAINT "lifecycle_exports_mode_check" CHECK ("mode" IN ('portable', 'restore'));

-- Сборки в работе (страховка потерянных джобов) и готовые к истечению — частичные индексы
CREATE INDEX "lifecycle_exports_live_idx" ON "lifecycle_exports" ("status", "created_at") WHERE "status" IN ('queued', 'running');
CREATE INDEX "lifecycle_exports_expires_idx" ON "lifecycle_exports" ("expires_at") WHERE "status" = 'ready';
