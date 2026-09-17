-- ============================================================
-- core/keys, фаза C: семейства refresh-сессий (reuse detection), токены вебхуков
-- Процессов хешем + envelope, secret_token Telegram.
-- ============================================================
-- Дописано руками: family_id существующих строк заполняется gen_random_uuid()
-- (каждая живая сессия — своё семейство), дефолт остаётся страховкой сырых вставок.

-- AlterTable
ALTER TABLE "process_triggers" ADD COLUMN     "webhook_secret_at" TIMESTAMP(3),
ADD COLUMN     "webhook_token_enc" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "family_id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
ADD COLUMN     "replaced_by_id" TEXT,
ADD COLUMN     "rotated_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");
