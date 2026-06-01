-- Phase 2: ad-hoc group chats.
-- Group owner (null for dm/context chats).
ALTER TABLE "chats" ADD COLUMN "created_by_id" TEXT;

-- History floor per member: only messages with seq >= visible_from_seq are visible.
-- Set to chat.last_seq when added to a group (WhatsApp-style); 0 = full history (DM, task chat).
ALTER TABLE "chat_members" ADD COLUMN "visible_from_seq" INTEGER NOT NULL DEFAULT 0;
