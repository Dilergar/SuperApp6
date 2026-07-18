-- CreateIndex
CREATE INDEX "calendar_event_reminders_sent_at_idx" ON "calendar_event_reminders"("sent_at");

-- CreateIndex
CREATE INDEX "mentions_created_at_idx" ON "mentions"("created_at");

-- CreateIndex
CREATE INDEX "messages_reply_to_id_idx" ON "messages"("reply_to_id");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "process_instances_version_id_idx" ON "process_instances"("version_id");

-- CreateIndex
CREATE INDEX "workspace_invitations_position_id_idx" ON "workspace_invitations"("position_id");
