-- CreateIndex
CREATE INDEX "process_step_runs_status_started_at_idx" ON "process_step_runs"("status", "started_at");
