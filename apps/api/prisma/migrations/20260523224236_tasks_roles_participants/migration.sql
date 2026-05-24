/*
  Warnings:

  - You are about to drop the column `assignee_id` on the `tasks` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignee_id_fkey";

-- DropIndex
DROP INDEX "tasks_assignee_id_idx";

-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "assignee_id",
ADD COLUMN     "all_day" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assigned_circle_id" TEXT,
ADD COLUMN     "gift_reward_id" TEXT,
ADD COLUMN     "recurrence_parent_id" TEXT,
ADD COLUMN     "recurrence_rule" TEXT,
ADD COLUMN     "reminder_at" TIMESTAMP(3),
ADD COLUMN     "reminder_sent_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "task_participants" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "reward_coins" INTEGER NOT NULL DEFAULT 0,
    "gift_reward_id" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_participants_user_id_status_idx" ON "task_participants"("user_id", "status");

-- CreateIndex
CREATE INDEX "task_participants_task_id_role_idx" ON "task_participants"("task_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "task_participants_task_id_user_id_key" ON "task_participants"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "tasks_assigned_circle_id_idx" ON "tasks"("assigned_circle_id");

-- CreateIndex
CREATE INDEX "tasks_reminder_at_idx" ON "tasks"("reminder_at");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_circle_id_fkey" FOREIGN KEY ("assigned_circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
