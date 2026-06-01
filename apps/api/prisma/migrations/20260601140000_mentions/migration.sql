-- Phase 5: Mentions Hub. One row per (message, mentioned user); a mention.received
-- Notification fires alongside. mentioned/mentioner cascade with the user.
CREATE TABLE "mentions" (
    "id" TEXT NOT NULL,
    "mentioned_user_id" TEXT NOT NULL,
    "mentioner_user_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chat_id" TEXT,
    "message_id" TEXT,
    "snippet" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mentions_message_id_mentioned_user_id_key" ON "mentions"("message_id", "mentioned_user_id");
CREATE INDEX "mentions_mentioned_user_id_created_at_idx" ON "mentions"("mentioned_user_id", "created_at");
CREATE INDEX "mentions_source_type_source_id_idx" ON "mentions"("source_type", "source_id");

ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentioned_user_id_fkey" FOREIGN KEY ("mentioned_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentioner_user_id_fkey" FOREIGN KEY ("mentioner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
