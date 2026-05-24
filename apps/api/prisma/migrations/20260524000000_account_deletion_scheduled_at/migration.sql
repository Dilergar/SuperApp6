-- Baseline migration: reconciles drift where `users.deletion_scheduled_at` was added to the
-- database during the account-deletion work but never recorded in migration history (0_init
-- only had `deleted_at`). Idempotent so it is a no-op on databases that already have the column
-- (this dev DB, applied via `prisma migrate resolve --applied`) yet still provisions it on a
-- fresh database replayed via `prisma migrate deploy`.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_scheduled_at" TIMESTAMP(3);
