-- AlterTable
ALTER TABLE "process_step_runs" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "process_triggers" ADD COLUMN     "event_type" TEXT;

-- CreateIndex
CREATE INDEX "process_triggers_workspace_id_type_enabled_event_type_idx" ON "process_triggers"("workspace_id", "type", "enabled", "event_type");
