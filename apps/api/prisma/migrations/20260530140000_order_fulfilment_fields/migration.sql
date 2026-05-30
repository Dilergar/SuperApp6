-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "event_id" TEXT,
ADD COLUMN     "task_days" INTEGER;

-- CreateIndex
CREATE INDEX "orders_task_id_idx" ON "orders"("task_id");

