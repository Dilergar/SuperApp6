-- AlterTable
ALTER TABLE "share_link_visits" ADD COLUMN     "guest_id" TEXT;

-- AlterTable
ALTER TABLE "share_links" ADD COLUMN     "require_identity" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "share_link_guests" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "first_verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_link_guests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_link_guests_owner_type_owner_id_phone_key" ON "share_link_guests"("owner_type", "owner_id", "phone");

-- CreateIndex
CREATE INDEX "share_link_visits_guest_id_idx" ON "share_link_visits"("guest_id");

-- AddForeignKey
ALTER TABLE "share_link_visits" ADD CONSTRAINT "share_link_visits_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "share_link_guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
