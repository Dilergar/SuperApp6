-- DropIndex
DROP INDEX "escrow_holds_creator_user_id_status_idx";

-- DropIndex
DROP INDEX "escrow_holds_currency_id_idx";

-- DropIndex
DROP INDEX "escrow_holds_status_idx";

-- DropIndex
DROP INDEX "escrow_holds_task_id_idx";

-- DropIndex
DROP INDEX "escrow_holds_task_id_participant_user_id_key";

-- AlterTable
ALTER TABLE "currencies" ADD COLUMN     "code" TEXT,
ADD COLUMN     "scale" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "escrow_holds" DROP COLUMN "creator_user_id",
DROP COLUMN "ledger_transfer_id",
DROP COLUMN "participant_user_id",
DROP COLUMN "task_id",
ADD COLUMN     "agreement_id" TEXT NOT NULL,
ADD COLUMN     "beneficiary_user_id" TEXT NOT NULL,
ADD COLUMN     "payer_user_id" TEXT NOT NULL,
ADD COLUMN     "pending_transfer_id" BIGINT,
ADD COLUMN     "posted_transfer_id" BIGINT;

-- DropTable
DROP TABLE "ledger_entries";

-- DropTable
DROP TABLE "wallet_balances";

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "held" BIGINT NOT NULL DEFAULT 0,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transfers" (
    "id" BIGSERIAL NOT NULL,
    "currency_id" TEXT NOT NULL,
    "debit_account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "pending_id" BIGINT,
    "agreement_id" TEXT,
    "idempotency_key" TEXT,
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_agreements" (
    "id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escrow_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_owner_type_owner_id_idx" ON "accounts"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "accounts_currency_id_type_idx" ON "accounts"("currency_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_currency_id_type_owner_type_owner_id_key" ON "accounts"("currency_id", "type", "owner_type", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transfers_idempotency_key_key" ON "ledger_transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_transfers_debit_account_id_id_idx" ON "ledger_transfers"("debit_account_id", "id");

-- CreateIndex
CREATE INDEX "ledger_transfers_credit_account_id_id_idx" ON "ledger_transfers"("credit_account_id", "id");

-- CreateIndex
CREATE INDEX "ledger_transfers_currency_id_idx" ON "ledger_transfers"("currency_id");

-- CreateIndex
CREATE INDEX "ledger_transfers_pending_id_idx" ON "ledger_transfers"("pending_id");

-- CreateIndex
CREATE INDEX "ledger_transfers_agreement_id_idx" ON "ledger_transfers"("agreement_id");

-- CreateIndex
CREATE INDEX "escrow_agreements_ref_type_ref_id_idx" ON "escrow_agreements"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "escrow_agreements_status_idx" ON "escrow_agreements"("status");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_agreements_ref_type_ref_id_key" ON "escrow_agreements"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "escrow_holds_payer_user_id_currency_id_status_idx" ON "escrow_holds"("payer_user_id", "currency_id", "status");

-- CreateIndex
CREATE INDEX "escrow_holds_currency_id_status_idx" ON "escrow_holds"("currency_id", "status");

-- CreateIndex
CREATE INDEX "escrow_holds_agreement_id_status_idx" ON "escrow_holds"("agreement_id", "status");

-- CreateIndex
CREATE INDEX "escrow_holds_beneficiary_user_id_status_idx" ON "escrow_holds"("beneficiary_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_holds_agreement_id_payer_user_id_beneficiary_user_id_key" ON "escrow_holds"("agreement_id", "payer_user_id", "beneficiary_user_id", "currency_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_holds" ADD CONSTRAINT "escrow_holds_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "escrow_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

