-- Ревью core/chatter: lease/attempts проекции плашек + оптимизация индексов.

-- Аренда claim'а и счётчик попыток (lease-модель core/voice): краш между claim и
-- постом → аренда протухнет → запись переберётся; после потолка попыток — dead-letter.
ALTER TABLE "chatter_entries"
  ADD COLUMN "chat_post_lease_until" TIMESTAMP(3),
  ADD COLUMN "chat_post_attempts" INTEGER NOT NULL DEFAULT 0;

-- Полный индекс редрайва → частичный: на append-forever таблице держит только
-- реально ждущие проекции строки (~0 в стабильном режиме), а не все записи навсегда.
DROP INDEX "chatter_entries_needs_chat_post_chat_posted_at_idx";
CREATE INDEX "chatter_entries_chat_post_pending_idx"
  ON "chatter_entries" ("chat_post_lease_until", "id")
  WHERE "needs_chat_post" AND "chat_posted_at" IS NULL;

-- Журнал организации с фильтром category → type_key IN (...): без этого индекса
-- category='staff' сканировал кучу по (workspace_id, id), проверяя type_key построчно.
CREATE INDEX "chatter_entries_workspace_id_type_key_id_idx"
  ON "chatter_entries" ("workspace_id", "type_key", "id");
