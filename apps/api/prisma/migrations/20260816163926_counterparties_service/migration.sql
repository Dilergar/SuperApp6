-- AlterTable
ALTER TABLE "org_documents" ADD COLUMN     "counterparty_contact_id" TEXT,
ADD COLUMN     "counterparty_id" TEXT;

-- CreateTable
CREATE TABLE "counterparties" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'legal',
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "bin" TEXT,
    "org_form" TEXT,
    "legal_address" TEXT,
    "kbe" TEXT,
    "vat_payer" BOOLEAN NOT NULL DEFAULT false,
    "vat_series" TEXT,
    "vat_number" TEXT,
    "vat_date" DATE,
    "director_name" TEXT,
    "sign_basis" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "comment" TEXT,
    "created_by_id" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "counterparties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counterparty_contacts" (
    "id" TEXT NOT NULL,
    "counterparty_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "counterparty_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counterparty_bank_accounts" (
    "id" TEXT NOT NULL,
    "counterparty_id" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "bik" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counterparty_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "counterparties_workspace_id_archived_at_idx" ON "counterparties"("workspace_id", "archived_at");

-- CreateIndex
CREATE INDEX "counterparties_workspace_id_name_idx" ON "counterparties"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "counterparty_contacts_counterparty_id_archived_at_idx" ON "counterparty_contacts"("counterparty_id", "archived_at");

-- CreateIndex
CREATE INDEX "counterparty_contacts_workspace_id_idx" ON "counterparty_contacts"("workspace_id");

-- CreateIndex
CREATE INDEX "counterparty_bank_accounts_counterparty_id_idx" ON "counterparty_bank_accounts"("counterparty_id");

-- CreateIndex
CREATE INDEX "org_documents_workspace_id_counterparty_id_idx" ON "org_documents"("workspace_id", "counterparty_id");

-- AddForeignKey
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counterparty_contacts" ADD CONSTRAINT "counterparty_contacts_counterparty_id_fkey" FOREIGN KEY ("counterparty_id") REFERENCES "counterparties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counterparty_bank_accounts" ADD CONSTRAINT "counterparty_bank_accounts_counterparty_id_fkey" FOREIGN KEY ("counterparty_id") REFERENCES "counterparties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- РУКАМИ (Prisma не выражает партиальный UNIQUE, комментарий-зеркало в schema.prisma):
-- «один живой контрагент на БИН в организации». Дубль среди живых → P2002 → 409;
-- архивная карточка номер отпускает — контрагента можно завести заново.
-- БИН — якорь будущего связывания организаций-арендаторов между собой.
CREATE UNIQUE INDEX "counterparties_workspace_bin_live"
  ON "counterparties" ("workspace_id", "bin")
  WHERE "bin" IS NOT NULL AND "archived_at" IS NULL;
