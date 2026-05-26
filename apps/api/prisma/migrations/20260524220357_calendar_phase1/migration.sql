/*
  Warnings:

  - You are about to drop the column `task_id` on the `calendar_events` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `calendar_events` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_task_id_fkey";

-- DropIndex
DROP INDEX "calendar_events_start_time_end_time_idx";

-- DropIndex
DROP INDEX "calendar_events_task_id_key";

-- DropIndex
DROP INDEX "calendar_events_user_id_idx";

-- AlterTable
ALTER TABLE "calendar_events" DROP COLUMN "task_id",
DROP COLUMN "type",
ADD COLUMN     "ex_dates" TIMESTAMP(3)[],
ADD COLUMN     "location" TEXT,
ADD COLUMN     "recurrence_id" TIMESTAMP(3),
ADD COLUMN     "recurrence_parent_id" TEXT,
ADD COLUMN     "reminder_offsets" INTEGER[],
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'inherit';

-- CreateTable
CREATE TABLE "calendar_event_reminders" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "occurrence_start" TIMESTAMP(3) NOT NULL,
    "minutes_before" INTEGER NOT NULL,
    "fire_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_event_reminders_fire_at_sent_at_idx" ON "calendar_event_reminders"("fire_at", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_reminders_event_id_user_id_occurrence_start__key" ON "calendar_event_reminders"("event_id", "user_id", "occurrence_start", "minutes_before");

-- CreateIndex
CREATE INDEX "calendar_events_user_id_start_time_idx" ON "calendar_events"("user_id", "start_time");

-- CreateIndex
CREATE INDEX "calendar_events_recurrence_parent_id_idx" ON "calendar_events"("recurrence_parent_id");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_recurrence_parent_id_fkey" FOREIGN KEY ("recurrence_parent_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
