-- CreateTable
CREATE TABLE "fin_books" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL DEFAULT 'user',
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Мои финансы',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_accounts" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subtype" TEXT,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'KZT',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "debt_total" BIGINT,
    "debt_monthly" BIGINT,
    "debt_months" INTEGER,
    "debt_due_day" INTEGER,
    "debt_closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_transactions" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "from_account_id" TEXT NOT NULL,
    "to_account_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "amount_to" BIGINT,
    "currency_code" TEXT NOT NULL,
    "occurred_on" DATE NOT NULL,
    "note" TEXT,
    "person_user_id" TEXT,
    "person_name" TEXT,
    "created_by_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "recurring_rule_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_budgets" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "category_account_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'KZT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_people" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fin_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_recurring_rules" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "from_account_id" TEXT NOT NULL,
    "to_account_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "amount_to" BIGINT,
    "note" TEXT,
    "person_user_id" TEXT,
    "person_name" TEXT,
    "interval" TEXT NOT NULL,
    "day_of_month" INTEGER,
    "weekday" INTEGER,
    "auto_record" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_recurring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_audit_logs" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fin_books_owner_type_owner_id_key" ON "fin_books"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "fin_accounts_book_id_kind_idx" ON "fin_accounts"("book_id", "kind");

-- CreateIndex
CREATE INDEX "fin_accounts_parent_id_idx" ON "fin_accounts"("parent_id");

-- CreateIndex
CREATE INDEX "fin_transactions_book_id_occurred_on_idx" ON "fin_transactions"("book_id", "occurred_on");

-- CreateIndex
CREATE INDEX "fin_transactions_from_account_id_idx" ON "fin_transactions"("from_account_id");

-- CreateIndex
CREATE INDEX "fin_transactions_to_account_id_idx" ON "fin_transactions"("to_account_id");

-- CreateIndex
CREATE INDEX "fin_transactions_book_id_person_user_id_idx" ON "fin_transactions"("book_id", "person_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "fin_budgets_book_id_category_account_id_period_key" ON "fin_budgets"("book_id", "category_account_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "fin_people_book_id_user_id_key" ON "fin_people"("book_id", "user_id");

-- CreateIndex
CREATE INDEX "fin_recurring_rules_active_next_run_at_idx" ON "fin_recurring_rules"("active", "next_run_at");

-- CreateIndex
CREATE INDEX "fin_recurring_rules_book_id_idx" ON "fin_recurring_rules"("book_id");

-- CreateIndex
CREATE INDEX "fin_audit_logs_book_id_created_at_idx" ON "fin_audit_logs"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "fin_audit_logs_entity_type_entity_id_idx" ON "fin_audit_logs"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "fin_accounts" ADD CONSTRAINT "fin_accounts_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "fin_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_accounts" ADD CONSTRAINT "fin_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "fin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "fin_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "fin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "fin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_budgets" ADD CONSTRAINT "fin_budgets_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "fin_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_people" ADD CONSTRAINT "fin_people_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "fin_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_recurring_rules" ADD CONSTRAINT "fin_recurring_rules_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "fin_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
