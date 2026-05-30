-- Phase 5 (cross-currency pricing): an order's price becomes N currency lines (OrderPrice),
-- mirroring ListingPrice. Existing single-currency orders are migrated to one line, then the
-- single currency_id/amount columns are dropped.

-- 1. New snapshot table (FK to orders cascade; FK-free to currencies, like listing_prices).
CREATE TABLE "order_prices" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    CONSTRAINT "order_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_prices_order_id_currency_id_key" ON "order_prices"("order_id", "currency_id");
CREATE INDEX "order_prices_currency_id_idx" ON "order_prices"("currency_id");
ALTER TABLE "order_prices"
    ADD CONSTRAINT "order_prices_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Migrate existing single-currency snapshots into a single price line each.
INSERT INTO "order_prices" ("id", "order_id", "currency_id", "amount")
SELECT gen_random_uuid(), "id", "currency_id", "amount" FROM "orders";

-- 3. Drop the now-redundant single-currency columns.
ALTER TABLE "orders" DROP COLUMN "currency_id";
ALTER TABLE "orders" DROP COLUMN "amount";
