-- ============================================================
-- РЕСУРСЫ → ОБОРУДОВАНИЕ. Семья Asset: сегодня kind='equipment', позже транспорт
-- и недвижимость — таблица одна, чтобы «что у нас есть» не собиралось из трёх.
--
-- Два НЕЗАВИСИМЫХ измерения: ГДЕ стоит (branchId + parentAssetId) и ЧЬЁ /
-- на чьём балансе (holdingKind + balanceLegalEntityId + holdingCounterpartyId).
-- Смешивать их нельзя: арендованная кофемашина стоит в нашем зале, но на балансе
-- арендодателя; своя машина может стоять у подрядчика.
--
-- Движение и ремонт — ЖУРНАЛЫ (append-only): «переместили» без записи о том, кто
-- и когда, — это потеря, а не экономия.
-- ============================================================

CREATE TABLE "asset_models" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'equipment',
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "category" TEXT,
    "specs" JSONB,
    "glyph" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_models_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_models_workspace_id_kind_name_key" ON "asset_models"("workspace_id", "kind", "name");
ALTER TABLE "asset_models" ADD CONSTRAINT "asset_models_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'equipment',
    "name" TEXT NOT NULL,
    "inventory_number" TEXT,
    "serial_number" TEXT,
    "branch_id" TEXT NOT NULL,
    "parent_asset_id" TEXT,
    "location_note" TEXT,
    "holding_kind" TEXT NOT NULL DEFAULT 'owned',
    "balance_legal_entity_id" TEXT,
    "holding_counterparty_id" TEXT,
    "custodian_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "purchased_on" DATE,
    "commissioned_on" DATE,
    "warranty_until" DATE,
    "purchase_price" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assets_workspace_id_branch_id_status_idx" ON "assets"("workspace_id", "branch_id", "status");
CREATE INDEX "assets_model_id_idx" ON "assets"("model_id");
CREATE INDEX "assets_parent_asset_id_idx" ON "assets"("parent_asset_id");
CREATE INDEX "assets_custodian_user_id_idx" ON "assets"("custodian_user_id");
CREATE INDEX "assets_balance_legal_entity_id_idx" ON "assets"("balance_legal_entity_id");
CREATE INDEX "assets_holding_counterparty_id_idx" ON "assets"("holding_counterparty_id");

ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: модель с экземплярами не удаляется (прикладной 409).
ALTER TABLE "assets" ADD CONSTRAINT "assets_model_id_fkey"
  FOREIGN KEY ("model_id") REFERENCES "asset_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Restrict: объект с оборудованием не удаляется молча.
ALTER TABLE "assets" ADD CONSTRAINT "assets_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_asset_id_fkey"
  FOREIGN KEY ("parent_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_balance_legal_entity_id_fkey"
  FOREIGN KEY ("balance_legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_holding_counterparty_id_fkey"
  FOREIGN KEY ("holding_counterparty_id") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "asset_moves" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_branch_id" TEXT,
    "to_branch_id" TEXT,
    "from_parent_asset_id" TEXT,
    "to_parent_asset_id" TEXT,
    "from_user_id" TEXT,
    "to_user_id" TEXT,
    "from_value" TEXT,
    "to_value" TEXT,
    "reason" TEXT,
    "moved_by_id" TEXT NOT NULL,
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_moves_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "asset_moves_asset_id_moved_at_idx" ON "asset_moves"("asset_id", "moved_at");
CREATE INDEX "asset_moves_workspace_id_idx" ON "asset_moves"("workspace_id");
ALTER TABLE "asset_moves" ADD CONSTRAINT "asset_moves_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_moves" ADD CONSTRAINT "asset_moves_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "asset_service_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'repair',
    "status" TEXT NOT NULL DEFAULT 'done',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduled_on" DATE,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "next_due_on" DATE,
    "cost" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "performed_by_user_id" TEXT,
    "counterparty_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "asset_service_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "asset_service_records_asset_id_scheduled_on_idx" ON "asset_service_records"("asset_id", "scheduled_on");
CREATE INDEX "asset_service_records_workspace_id_status_next_due_on_idx" ON "asset_service_records"("workspace_id", "status", "next_due_on");
CREATE INDEX "asset_service_records_counterparty_id_idx" ON "asset_service_records"("counterparty_id");
ALTER TABLE "asset_service_records" ADD CONSTRAINT "asset_service_records_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_service_records" ADD CONSTRAINT "asset_service_records_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_service_records" ADD CONSTRAINT "asset_service_records_counterparty_id_fkey"
  FOREIGN KEY ("counterparty_id") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- РУКОПИСНОЕ (Prisma не выражает партиальные уникумы).
-- ============================================================

-- Инвентарный номер уникален среди ЖИВЫХ экземпляров организации.
CREATE UNIQUE INDEX "assets_inventory_live_key"
  ON "assets"("workspace_id", "inventory_number")
  WHERE "inventory_number" IS NOT NULL AND "archived_at" IS NULL;
