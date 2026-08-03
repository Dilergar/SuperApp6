-- AlterTable
ALTER TABLE "users" ADD COLUMN     "id_doc_issued_at" DATE,
ADD COLUMN     "id_doc_issued_by" TEXT,
ADD COLUMN     "id_doc_number" TEXT,
ADD COLUMN     "iin" TEXT,
ADD COLUMN     "residential_address" TEXT;

-- CreateTable
CREATE TABLE "workspace_requisites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "org_form" TEXT,
    "tax_regime" TEXT,
    "legal_name" TEXT,
    "bin" TEXT,
    "legal_address" TEXT,
    "kbe" TEXT,
    "vat_payer" BOOLEAN NOT NULL DEFAULT false,
    "vat_series" TEXT,
    "vat_number" TEXT,
    "vat_date" DATE,
    "director_user_id" TEXT,
    "sign_basis" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_requisites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_bank_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "bik" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_payment_cards" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "pan_encrypted" TEXT NOT NULL,
    "pan_last4" TEXT NOT NULL,
    "iban_encrypted" TEXT,
    "holder_name" TEXT NOT NULL,
    "exp_month" INTEGER NOT NULL,
    "exp_year" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_payment_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_requisites_workspace_id_key" ON "workspace_requisites"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_bank_accounts_workspace_id_idx" ON "workspace_bank_accounts"("workspace_id");

-- CreateIndex
CREATE INDEX "user_payment_cards_user_id_idx" ON "user_payment_cards"("user_id");

-- AddForeignKey
ALTER TABLE "workspace_requisites" ADD CONSTRAINT "workspace_requisites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_bank_accounts" ADD CONSTRAINT "workspace_bank_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_payment_cards" ADD CONSTRAINT "user_payment_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
