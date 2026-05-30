-- Phase 8 (Wishlist): a user's list of wants. No price — a person from the owner's окружение copies
-- a wish into a Listing in their own shop (listings.source_wish_item_id links back), and the wish
-- auto-fulfils when that lot settles. Visibility is shared via the access engine (wishlist:<owner>).
CREATE TABLE "wish_items" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "link" TEXT,
    "item_type" TEXT NOT NULL DEFAULT 'material',
    "status" TEXT NOT NULL DEFAULT 'active',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "fulfilled_at" TIMESTAMP(3),
    CONSTRAINT "wish_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wish_items_owner_id_status_idx" ON "wish_items"("owner_id", "status");
