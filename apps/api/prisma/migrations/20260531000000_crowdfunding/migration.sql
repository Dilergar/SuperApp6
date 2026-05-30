-- Phase 6 (crowdfunding): a crowdfunded listing is collected jointly. One campaign = one Order
-- (status 'funding'), goal = its OrderPrice[] (multi-currency). Pledges = OrderContribution rows,
-- one escrow leg each. All-or-nothing: captured to the owner only when EVERY goal currency is filled.

ALTER TABLE "orders" ADD COLUMN "crowdfunding" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "order_contributions" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "contributor_id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_contributions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_contributions_order_id_contributor_id_currency_id_key" ON "order_contributions"("order_id", "contributor_id", "currency_id");
CREATE INDEX "order_contributions_order_id_idx" ON "order_contributions"("order_id");
CREATE INDEX "order_contributions_contributor_id_idx" ON "order_contributions"("contributor_id");
ALTER TABLE "order_contributions"
    ADD CONSTRAINT "order_contributions_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most ONE active crowdfunding campaign per listing (partial unique; Prisma can't express it).
CREATE UNIQUE INDEX "orders_active_campaign_per_listing"
    ON "orders"("listing_id")
    WHERE "crowdfunding" = true AND "status" IN ('funding', 'pending');
