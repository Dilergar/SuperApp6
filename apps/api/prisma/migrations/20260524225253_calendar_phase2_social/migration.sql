/*
  Warnings:

  - You are about to drop the column `permission` on the `calendar_shares` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "calendar_shares" DROP COLUMN "permission",
ADD COLUMN     "access_level" TEXT NOT NULL DEFAULT 'busy';

-- AlterTable
ALTER TABLE "circles" ADD COLUMN     "calendar_visibility" TEXT NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "event_participants" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'attendee',
    "rsvp" TEXT NOT NULL DEFAULT 'pending',
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_participants_user_id_idx" ON "event_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_participants_event_id_user_id_key" ON "event_participants"("event_id", "user_id");

-- AddForeignKey
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
