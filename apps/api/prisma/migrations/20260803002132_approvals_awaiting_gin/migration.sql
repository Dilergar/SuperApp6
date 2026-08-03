-- DropIndex
DROP INDEX "approval_steps_status_assignee_type_assignee_id_idx";

-- CreateIndex
CREATE INDEX "approval_steps_awaiting" ON "approval_steps" USING GIN ("awaiting_user_ids" array_ops);
