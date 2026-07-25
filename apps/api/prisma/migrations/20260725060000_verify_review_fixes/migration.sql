-- Ревью движка подтверждений core/verify (2026-07-25).
--
-- 1. users.token_epoch — поколение токенов. Инкремент = мгновенный отзыв ВСЕХ выданных
--    access-токенов (JwtStrategy сверяет epoch из payload). Раньше «отозвали все сессии»
--    удаляло только строки session, а украденный access-токен жил ещё до 15 минут.
--    Дефолт 0 = ровно то, что лежит в уже выданных токенах (их поля epoch нет → 0),
--    поэтому раскатка никого не разлогинивает.
-- 2. verify_challenges.provider_message_id / delivery — доказательство отправки для
--    поддержки и явная метка «код никуда не уходил» (нейтральная имитация / тест-карта).
-- 3. Индекс (phone, last_sent_at) — потолки SMS на номер считаются по времени последней
--    отправки, а не по created_at цепочки.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "token_epoch" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "verify_challenges" ADD COLUMN "provider_message_id" TEXT;
ALTER TABLE "verify_challenges" ADD COLUMN "delivery" TEXT NOT NULL DEFAULT 'sms';

-- CreateIndex
CREATE INDEX "verify_challenges_phone_last_sent_at_idx" ON "verify_challenges"("phone", "last_sent_at");
