-- CreateTable
CREATE TABLE "currencies" (
    "id" TEXT NOT NULL,
    "issuer_type" TEXT NOT NULL,
    "issuer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "currency_type" TEXT NOT NULL DEFAULT 'CUSTOM_COIN',
    "visibility_policy" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_renamed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "currency_id" TEXT NOT NULL,
    "account_user_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "transfer_id" TEXT,
    "task_id" TEXT,
    "idempotency_key" TEXT,
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_balances" (
    "id" TEXT NOT NULL,
    "account_user_id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "held_amount" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_holds" (
    "id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "participant_user_id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ledger_transfer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escrow_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "currencies_issuer_type_issuer_id_idx" ON "currencies"("issuer_type", "issuer_id");

-- CreateIndex
CREATE INDEX "currencies_status_idx" ON "currencies"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_account_user_id_currency_id_id_idx" ON "ledger_entries"("account_user_id", "currency_id", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_currency_id_idx" ON "ledger_entries"("currency_id");

-- CreateIndex
CREATE INDEX "ledger_entries_transfer_id_idx" ON "ledger_entries"("transfer_id");

-- CreateIndex
CREATE INDEX "ledger_entries_task_id_idx" ON "ledger_entries"("task_id");

-- CreateIndex
CREATE INDEX "wallet_balances_currency_id_idx" ON "wallet_balances"("currency_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_balances_account_user_id_currency_id_key" ON "wallet_balances"("account_user_id", "currency_id");

-- CreateIndex
CREATE INDEX "escrow_holds_currency_id_idx" ON "escrow_holds"("currency_id");

-- CreateIndex
CREATE INDEX "escrow_holds_task_id_idx" ON "escrow_holds"("task_id");

-- CreateIndex
CREATE INDEX "escrow_holds_creator_user_id_status_idx" ON "escrow_holds"("creator_user_id", "status");

-- CreateIndex
CREATE INDEX "escrow_holds_status_idx" ON "escrow_holds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_holds_task_id_participant_user_id_key" ON "escrow_holds"("task_id", "participant_user_id");

-- Manual: PARTIAL unique index — exactly ONE active currency per issuer (soft-deleted rows
-- excluded so a new currency can be created after deletion). Prisma can't express partial
-- uniques in schema.prisma; a future `prisma migrate dev` may try to DROP this as "drift" —
-- keep it. The service layer also guards this invariant transactionally.
CREATE UNIQUE INDEX "currencies_active_issuer_key" ON "currencies"("issuer_type", "issuer_id") WHERE "status" = 'active';
