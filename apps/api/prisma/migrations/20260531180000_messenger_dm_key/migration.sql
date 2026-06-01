-- Canonical DM key: exactly one DM chat per user pair.
ALTER TABLE "chats" ADD COLUMN "dm_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "chats_dm_key_key" ON "chats"("dm_key");
