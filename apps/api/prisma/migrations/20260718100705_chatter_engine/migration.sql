-- CreateTable
CREATE TABLE "chatter_entries" (
    "id" BIGSERIAL NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "type_key" TEXT NOT NULL,
    "changes" JSONB,
    "payload" JSONB,
    "needs_chat_post" BOOLEAN NOT NULL DEFAULT false,
    "chat_posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatter_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chatter_entries_ref_type_ref_id_id_idx" ON "chatter_entries"("ref_type", "ref_id", "id");

-- CreateIndex
CREATE INDEX "chatter_entries_workspace_id_id_idx" ON "chatter_entries"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "chatter_entries_needs_chat_post_chat_posted_at_idx" ON "chatter_entries"("needs_chat_post", "chat_posted_at");
