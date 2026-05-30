-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT,
    "title_snapshot" TEXT NOT NULL,
    "showcase_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currency_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "item_type" TEXT NOT NULL,
    "with_task" BOOLEAN NOT NULL DEFAULT false,
    "task_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_shop_id_status_idx" ON "orders"("shop_id", "status");

-- CreateIndex
CREATE INDEX "orders_buyer_id_status_idx" ON "orders"("buyer_id", "status");

-- CreateIndex
CREATE INDEX "orders_seller_id_status_idx" ON "orders"("seller_id", "status");

-- CreateIndex
CREATE INDEX "orders_listing_id_idx" ON "orders"("listing_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

