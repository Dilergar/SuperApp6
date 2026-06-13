-- AlterTable
ALTER TABLE "process_step_runs" ADD COLUMN     "activated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by_id" TEXT,
ADD COLUMN     "deadline_at" TIMESTAMP(3),
ADD COLUMN     "decision" TEXT,
ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "escalated_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "process_step_runs_deadline_at_idx" ON "process_step_runs"("deadline_at");

-- CreateIndex
CREATE INDEX "process_step_runs_department_id_idx" ON "process_step_runs"("department_id");
