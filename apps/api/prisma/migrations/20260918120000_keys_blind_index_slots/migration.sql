-- ============================================================
-- core/keys: слоты слепого индекса, состояние до заморозки, индекс по корню
--
-- 1) Слепой индекс живёт в ДВУХ колонках-слотах (`_bi` — слот 0, `_bi_alt` — слот 1).
--    Каждая версия mac-ключа `blind_index` пишет в СВОЙ слот: смена ключа заполняет
--    второй слот в фоне, переключает поиск на него одним движением и очищает первый.
--    В любой момент в колонке ровно одна версия ключа — уникальность и вход по номеру
--    работают без окна простоя. Индексы второго слота — зеркало первого.
-- 2) `crypto_key_versions.slot` — слот версии `blind_index`.
-- 3) `crypto_key_versions.frozen_from` — состояние ДО заморозки скоупа: разморозка
--    возвращает ровно его и не трогает версии, выключенные поштучно.
-- 4) Индекс по `root_kid` — ротация корня перешивает версии порциями по отпечатку.
-- ============================================================

-- AlterTable
ALTER TABLE "contact_invitations" ADD COLUMN     "to_phone_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "counterparties" ADD COLUMN     "phone_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "counterparty_contacts" ADD COLUMN     "phone_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "crypto_key_versions" ADD COLUMN     "frozen_from" TEXT,
ADD COLUMN     "slot" INTEGER;

-- AlterTable
ALTER TABLE "share_link_guests" ADD COLUMN     "phone_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "sign_acts" ADD COLUMN     "cert_subject_iin_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_bi_alt" TEXT,
ADD COLUMN     "iin_bi_alt" TEXT,
ADD COLUMN     "phone_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "verify_challenges" ADD COLUMN     "phone_bi_alt" TEXT;

-- AlterTable
ALTER TABLE "workspace_invitations" ADD COLUMN     "to_phone_bi_alt" TEXT;

-- CreateIndex
CREATE INDEX "contact_invitations_to_phone_bi_alt_idx" ON "contact_invitations"("to_phone_bi_alt");

-- CreateIndex
CREATE INDEX "contact_invitations_from_user_id_to_phone_bi_alt_status_idx" ON "contact_invitations"("from_user_id", "to_phone_bi_alt", "status");

-- Двойник партиального уникума pending-приглашений по второму слоту (Prisma его не выражает)
CREATE UNIQUE INDEX "contact_invitations_one_pending_per_phone_bi_alt"
  ON "contact_invitations" ("from_user_id", "to_phone_bi_alt") WHERE "status" = 'pending' AND "to_phone_bi_alt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "counterparties_workspace_id_phone_bi_alt_idx" ON "counterparties"("workspace_id", "phone_bi_alt");

-- CreateIndex
CREATE INDEX "counterparty_contacts_workspace_id_phone_bi_alt_idx" ON "counterparty_contacts"("workspace_id", "phone_bi_alt");

-- CreateIndex
CREATE INDEX "crypto_key_versions_root_kid_idx" ON "crypto_key_versions"("root_kid");

-- CreateIndex
CREATE UNIQUE INDEX "share_link_guests_owner_type_owner_id_phone_bi_alt_key" ON "share_link_guests"("owner_type", "owner_id", "phone_bi_alt");

-- CreateIndex
CREATE INDEX "sign_acts_cert_subject_iin_bi_alt_idx" ON "sign_acts"("cert_subject_iin_bi_alt");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_bi_alt_key" ON "users"("phone_bi_alt");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_bi_alt_key" ON "users"("email_bi_alt");

-- CreateIndex
CREATE INDEX "users_iin_bi_alt_idx" ON "users"("iin_bi_alt");

-- CreateIndex
CREATE INDEX "verify_challenges_phone_bi_alt_purpose_created_at_idx" ON "verify_challenges"("phone_bi_alt", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "verify_challenges_phone_bi_alt_last_sent_at_idx" ON "verify_challenges"("phone_bi_alt", "last_sent_at");

-- CreateIndex
CREATE INDEX "workspace_invitations_to_phone_bi_alt_idx" ON "workspace_invitations"("to_phone_bi_alt");

-- Данные: все существующие версии `blind_index` писали в `_bi` — это слот 0
UPDATE "crypto_key_versions" v SET "slot" = 0
  FROM "crypto_keys" k
 WHERE k."id" = v."key_id" AND k."purpose" = 'mac' AND k."name" = 'blind_index';

-- Данные: версии, выключенные до этой миграции, разморозка возвращала в `active` — так и остаётся
UPDATE "crypto_key_versions" SET "frozen_from" = 'active' WHERE "state" = 'disabled';
