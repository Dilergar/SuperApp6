-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showcases" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "showcases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showcase_shares" (
    "id" TEXT NOT NULL,
    "showcase_id" TEXT NOT NULL,
    "principal_type" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "showcase_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "showcase_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "item_type" TEXT NOT NULL DEFAULT 'material',
    "with_task" BOOLEAN NOT NULL DEFAULT false,
    "task_days" INTEGER,
    "crowdfunding" BOOLEAN NOT NULL DEFAULT false,
    "stock_limit" INTEGER,
    "stock_sold" INTEGER NOT NULL DEFAULT 0,
    "available_from" TIMESTAMP(3),
    "available_until" TIMESTAMP(3),
    "discount_percent" INTEGER,
    "discount_until" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "source_wish_item_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_prices" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "listing_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_owner_type_owner_id_key" ON "shops"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "showcases_shop_id_idx" ON "showcases"("shop_id");

-- CreateIndex
CREATE INDEX "showcase_shares_principal_type_principal_id_idx" ON "showcase_shares"("principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "showcase_shares_showcase_id_principal_type_principal_id_key" ON "showcase_shares"("showcase_id", "principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "listings_showcase_id_status_idx" ON "listings"("showcase_id", "status");

-- CreateIndex
CREATE INDEX "listings_source_wish_item_id_idx" ON "listings"("source_wish_item_id");

-- CreateIndex
CREATE INDEX "listing_prices_currency_id_idx" ON "listing_prices"("currency_id");

-- CreateIndex
CREATE UNIQUE INDEX "listing_prices_listing_id_currency_id_key" ON "listing_prices"("listing_id", "currency_id");

-- AddForeignKey
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "showcase_shares" ADD CONSTRAINT "showcase_shares_showcase_id_fkey" FOREIGN KEY ("showcase_id") REFERENCES "showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_showcase_id_fkey" FOREIGN KEY ("showcase_id") REFERENCES "showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_prices" ADD CONSTRAINT "listing_prices_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

