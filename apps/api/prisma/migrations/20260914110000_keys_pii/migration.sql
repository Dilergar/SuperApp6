-- ============================================================
-- core/keys, фаза D: ПДн под движком ключей — колонки `_enc` (envelope) и `_bi`
-- (слепой индекс) рядом с открытым текстом (окно dual-write, чтение по
-- KEYS_PII_READ_MODE), журнал чтений ПДн, скоуп организации у счетов контрагентов.
-- Дописано руками: бэкфилл workspace_id счетов контрагентов из родителя, партиальный
-- UNIQUE-двойник pending-приглашений по слепому индексу, снятие БД-дефолта family_id
-- (строки заполнены миграцией keys_sessions_webhooks; дальше id ставит Prisma).
-- ============================================================

-- AlterTable
ALTER TABLE "contact_invitations" ADD COLUMN     "to_phone_bi" TEXT,
ADD COLUMN     "to_phone_enc" TEXT;

-- AlterTable
ALTER TABLE "counterparties" ADD COLUMN     "email_enc" TEXT,
ADD COLUMN     "phone_bi" TEXT,
ADD COLUMN     "phone_enc" TEXT;

-- AlterTable
ALTER TABLE "counterparty_bank_accounts" ADD COLUMN     "iban_enc" TEXT,
ADD COLUMN     "workspace_id" TEXT;

-- Скоуп KEK счёта — организация контрагента (денормализация, как у counterparty_contacts)
UPDATE "counterparty_bank_accounts" a SET "workspace_id" = c."workspace_id"
  FROM "counterparties" c WHERE c."id" = a."counterparty_id" AND a."workspace_id" IS NULL;

-- AlterTable
ALTER TABLE "counterparty_contacts" ADD COLUMN     "email_enc" TEXT,
ADD COLUMN     "phone_bi" TEXT,
ADD COLUMN     "phone_enc" TEXT;

-- AlterTable
ALTER TABLE "sessions" ALTER COLUMN "family_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "share_link_guests" ADD COLUMN     "phone_bi" TEXT,
ADD COLUMN     "phone_enc" TEXT;

-- AlterTable
ALTER TABLE "sign_acts" ADD COLUMN     "cert_subject_iin_bi" TEXT,
ADD COLUMN     "cert_subject_iin_enc" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "date_of_birth_enc" TEXT,
ADD COLUMN     "email_bi" TEXT,
ADD COLUMN     "email_enc" TEXT,
ADD COLUMN     "id_doc_issued_by_enc" TEXT,
ADD COLUMN     "id_doc_number_enc" TEXT,
ADD COLUMN     "iin_bi" TEXT,
ADD COLUMN     "iin_enc" TEXT,
ADD COLUMN     "phone_bi" TEXT,
ADD COLUMN     "phone_enc" TEXT,
ADD COLUMN     "residential_address_enc" TEXT;

-- AlterTable
ALTER TABLE "verify_challenges" ADD COLUMN     "phone_bi" TEXT,
ADD COLUMN     "phone_enc" TEXT;

-- AlterTable
ALTER TABLE "workspace_bank_accounts" ADD COLUMN     "iban_enc" TEXT;

-- AlterTable
ALTER TABLE "workspace_invitations" ADD COLUMN     "to_phone_bi" TEXT,
ADD COLUMN     "to_phone_enc" TEXT;

-- CreateTable
CREATE TABLE "pii_access_log" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_kind" TEXT NOT NULL DEFAULT 'user',
    "workspace_id" TEXT,
    "entity" TEXT NOT NULL,
    "fields" TEXT[],
    "count" INTEGER NOT NULL,
    "sample_ids" TEXT[],

    CONSTRAINT "pii_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pii_access_log_occurred_at_idx" ON "pii_access_log"("occurred_at");

-- CreateIndex
CREATE INDEX "pii_access_log_actor_id_occurred_at_idx" ON "pii_access_log"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "contact_invitations_to_phone_bi_idx" ON "contact_invitations"("to_phone_bi");

-- CreateIndex
CREATE INDEX "contact_invitations_from_user_id_to_phone_bi_status_idx" ON "contact_invitations"("from_user_id", "to_phone_bi", "status");

-- Двойник партиального уникума pending-приглашений по слепому индексу (Prisma его не выражает)
CREATE UNIQUE INDEX "contact_invitations_one_pending_per_phone_bi"
  ON "contact_invitations" ("from_user_id", "to_phone_bi") WHERE "status" = 'pending' AND "to_phone_bi" IS NOT NULL;

-- CreateIndex
CREATE INDEX "counterparties_workspace_id_phone_bi_idx" ON "counterparties"("workspace_id", "phone_bi");

-- CreateIndex
CREATE INDEX "counterparty_bank_accounts_workspace_id_idx" ON "counterparty_bank_accounts"("workspace_id");

-- CreateIndex
CREATE INDEX "counterparty_contacts_workspace_id_phone_bi_idx" ON "counterparty_contacts"("workspace_id", "phone_bi");

-- CreateIndex
CREATE UNIQUE INDEX "share_link_guests_owner_type_owner_id_phone_bi_key" ON "share_link_guests"("owner_type", "owner_id", "phone_bi");

-- CreateIndex
CREATE INDEX "sign_acts_cert_subject_iin_bi_idx" ON "sign_acts"("cert_subject_iin_bi");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_bi_key" ON "users"("phone_bi");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_bi_key" ON "users"("email_bi");

-- CreateIndex
CREATE INDEX "users_iin_bi_idx" ON "users"("iin_bi");

-- CreateIndex
CREATE INDEX "verify_challenges_phone_bi_purpose_created_at_idx" ON "verify_challenges"("phone_bi", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "verify_challenges_phone_bi_last_sent_at_idx" ON "verify_challenges"("phone_bi", "last_sent_at");

-- CreateIndex
CREATE INDEX "workspace_invitations_to_phone_bi_idx" ON "workspace_invitations"("to_phone_bi");
