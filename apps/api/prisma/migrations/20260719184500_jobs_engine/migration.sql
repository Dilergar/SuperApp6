-- ============================================
-- JOBS ENGINE (core/jobs) — 10-й платформенный движок: фоновые джобы / transactional outbox
-- ============================================

-- CreateTable
CREATE TABLE "jobs" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "queue" TEXT NOT NULL DEFAULT 'default',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'available',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "lease_until" TIMESTAMP(3),
    "unique_key" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- Партиальные индексы (Prisma не выражает WHERE — руками; зеркалятся комментами в schema.prisma).

-- Горячий claim-путь: … WHERE status='available' AND queue=$1 AND run_at<=now()
-- ORDER BY priority, run_at, id FOR UPDATE SKIP LOCKED
CREATE INDEX "jobs_claim_idx" ON "jobs"("queue", "priority", "run_at", "id") WHERE "status" = 'available';

-- Reaper протухших аренд
CREATE INDEX "jobs_lease_idx" ON "jobs"("lease_until") WHERE "status" = 'executing';

-- Идемпотентная постановка/отмена: uniqueKey уникален среди ЖИВЫХ джобов
-- (терминальные не мешают повторной постановке того же ключа)
CREATE UNIQUE INDEX "jobs_unique_key_live" ON "jobs"("type", "unique_key") WHERE "status" IN ('available', 'executing') AND "unique_key" IS NOT NULL;

-- Ретеншн терминальных строк (движок чистит сам)
CREATE INDEX "jobs_retention_idx" ON "jobs"("status", "finished_at") WHERE "status" IN ('completed', 'discarded', 'cancelled');

-- ============================================
-- Chatter: lease-механика плашек переезжает в core/jobs — колонки аренды/попыток больше не нужны.
-- Старый частичный индекс включал chat_post_lease_until и умер бы каскадом с колонкой;
-- пересоздаём без неё (кормит бэкфилл/страховку незапощенных плашек на bootstrap).
-- ============================================

-- DropIndex
DROP INDEX IF EXISTS "chatter_entries_chat_post_pending_idx";

-- AlterTable
ALTER TABLE "chatter_entries" DROP COLUMN "chat_post_attempts",
DROP COLUMN "chat_post_lease_until";

-- CreateIndex (partial, руками)
CREATE INDEX "chatter_entries_chat_post_pending_idx" ON "chatter_entries"("id") WHERE "needs_chat_post" AND "chat_posted_at" IS NULL;
