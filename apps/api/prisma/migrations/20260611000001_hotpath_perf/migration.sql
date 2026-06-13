-- Arch-review block 4: hot-path performance.

-- 1) Materialized recurrence end for calendar masters (null = infinite series).
--    Range queries add `recurrence_ends_at IS NULL OR >= from` so long-finished series
--    stop being fetched + RRULE-expanded on every calendar view forever.
ALTER TABLE "calendar_events" ADD COLUMN "recurrence_ends_at" TIMESTAMP(3);

-- 2) Numeric priority for tasks ORDER BY (string priority sorts high < low — visible bug).
ALTER TABLE "tasks" ADD COLUMN "priority_rank" INTEGER NOT NULL DEFAULT 2;
UPDATE "tasks" SET "priority_rank" = CASE "priority"
  WHEN 'urgent' THEN 4
  WHEN 'high'   THEN 3
  WHEN 'medium' THEN 2
  ELSE 1
END;

-- 3) Drop duplicate indexes (each fully covered by an existing unique/composite index) —
--    a pure write-amplification tax on every INSERT/UPDATE of these hot tables.
DROP INDEX IF EXISTS "messages_chat_id_seq_idx";              -- dup of unique (chat_id, seq)
DROP INDEX IF EXISTS "user_roles_user_id_idx";                -- covered by unique (user_id, role, context, tenant_id)
DROP INDEX IF EXISTS "contact_invitations_from_user_id_idx";  -- covered by (from_user_id, status)
DROP INDEX IF EXISTS "contact_invitations_to_user_id_idx";    -- covered by (to_user_id, status)
DROP INDEX IF EXISTS "escrow_agreements_ref_type_ref_id_idx"; -- dup of unique (ref_type, ref_id)
