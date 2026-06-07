-- AlterTable
ALTER TABLE "circles" ADD COLUMN     "equipped_skin_instance_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "default_skin_instance_id" TEXT,
ADD COLUMN     "premium_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "card_skins" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "author_id" TEXT,
    "rarity" TEXT NOT NULL DEFAULT 'common',
    "price_amount" BIGINT NOT NULL DEFAULT 0,
    "supply" INTEGER,
    "minted" INTEGER NOT NULL DEFAULT 0,
    "available_from" TIMESTAMP(3),
    "available_until" TIMESTAMP(3),
    "tokens" JSONB NOT NULL,
    "decor" TEXT NOT NULL DEFAULT 'none',
    "frame_url" TEXT,
    "background_url" TEXT,
    "effect_url" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_skins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_skin_instances" (
    "id" TEXT NOT NULL,
    "skin_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "serial" INTEGER,
    "acquired_via" TEXT NOT NULL DEFAULT 'purchase',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_skin_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_skin_transfers" (
    "id" BIGSERIAL NOT NULL,
    "instance_id" TEXT NOT NULL,
    "from_user_id" TEXT,
    "to_user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_skin_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "card_skins_status_idx" ON "card_skins"("status");

-- CreateIndex
CREATE INDEX "card_skin_instances_owner_id_idx" ON "card_skin_instances"("owner_id");

-- CreateIndex
CREATE INDEX "card_skin_instances_skin_id_idx" ON "card_skin_instances"("skin_id");

-- CreateIndex
CREATE INDEX "card_skin_transfers_instance_id_idx" ON "card_skin_transfers"("instance_id");

-- AddForeignKey
ALTER TABLE "card_skin_instances" ADD CONSTRAINT "card_skin_instances_skin_id_fkey" FOREIGN KEY ("skin_id") REFERENCES "card_skins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_skin_transfers" ADD CONSTRAINT "card_skin_transfers_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "card_skin_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
