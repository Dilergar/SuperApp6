-- Phase 7: message reply/quote + scheduled messages ("Напомнить").

-- Reply/quote: a message may point to another message it quotes.
ALTER TABLE "messages" ADD COLUMN "reply_to_id" TEXT;
ALTER TABLE "messages"
    ADD CONSTRAINT "messages_reply_to_id_fkey"
    FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Scheduled messages: author schedules a message; a cron fires due ones into the chat.
CREATE TABLE "scheduled_messages" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reply_to_id" TEXT,
    "send_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sent_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "scheduled_messages_status_send_at_idx" ON "scheduled_messages"("status", "send_at");
CREATE INDEX "scheduled_messages_chat_id_author_id_idx" ON "scheduled_messages"("chat_id", "author_id");
ALTER TABLE "scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
