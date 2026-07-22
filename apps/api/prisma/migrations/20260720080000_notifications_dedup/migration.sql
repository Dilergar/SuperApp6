-- Волна 1 движка джобов: создание уведомлений переезжает с шины на джоб notifications.dispatch.
-- dedup_key = идемпотентность at-least-once (ретрай джоба не дублит строки);
-- NULL у прямых notify()-вызовов — в Postgres NULL'ы в unique-индексе не конфликтуют.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "dedup_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notifications"("dedup_key");
