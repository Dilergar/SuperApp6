-- Phase 2 review fix #1: enforce ONE context chat per parent (e.g. one chat per task).
-- A create-create race could spawn duplicate task chats. Dedup first (keep the
-- earliest-created chat per parent; drop the rest — their messages/members cascade),
-- then add the unique constraint. NULL parents (dm/group) are exempt (Postgres NULLs
-- are distinct), so this only constrains context chats.

-- 1) Remove access tuples of the soon-to-be-deleted duplicate chats.
DELETE FROM "relation_tuples"
WHERE "resource_type" = 'chat'
  AND "resource_id" IN (
    SELECT c.id FROM "chats" c
    WHERE c.parent_type IS NOT NULL
      AND c.id <> (
        SELECT c2.id FROM "chats" c2
        WHERE c2.parent_type = c.parent_type AND c2.parent_id = c.parent_id
        ORDER BY c2.created_at ASC, c2.id ASC
        LIMIT 1
      )
  );

-- 2) Delete the duplicate chats themselves (messages + chat_members cascade).
DELETE FROM "chats" c
WHERE c.parent_type IS NOT NULL
  AND c.id <> (
    SELECT c2.id FROM "chats" c2
    WHERE c2.parent_type = c.parent_type AND c2.parent_id = c.parent_id
    ORDER BY c2.created_at ASC, c2.id ASC
    LIMIT 1
  );

-- 3) Now the unique index can be created safely.
CREATE UNIQUE INDEX "chats_parent_type_parent_id_key" ON "chats"("parent_type", "parent_id");
