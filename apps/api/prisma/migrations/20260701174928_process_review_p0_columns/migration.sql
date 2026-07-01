-- AlterTable
ALTER TABLE "process_instances" ADD COLUMN     "steps_spawned" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "process_step_runs" ADD COLUMN     "leased_until" TIMESTAMP(3);
