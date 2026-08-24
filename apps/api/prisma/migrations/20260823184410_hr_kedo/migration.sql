-- AlterTable
ALTER TABLE "doc_templates" ADD COLUMN     "library_key" TEXT;

-- AlterTable
ALTER TABLE "doc_types" ADD COLUMN     "library_key" TEXT,
ADD COLUMN     "retention_years" INTEGER,
ADD COLUMN     "special_delivery" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "org_documents" ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "delivery_method" TEXT,
ADD COLUMN     "delivery_mode" TEXT NOT NULL DEFAULT 'electronic',
ADD COLUMN     "delivery_track_number" TEXT,
ADD COLUMN     "hr_action_id" TEXT;

-- CreateTable
CREATE TABLE "hr_employments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hired_at" DATE,
    "fired_at" DATE,
    "dismissal_ground" TEXT,
    "contract_number" TEXT,
    "contract_date" DATE,
    "contract_type" TEXT NOT NULL DEFAULT 'indefinite',
    "contract_end_at" DATE,
    "contract_extensions_count" INTEGER NOT NULL DEFAULT 0,
    "probation_until" DATE,
    "legal_position_id" TEXT,
    "legal_position_name" TEXT,
    "legal_branch_id" TEXT,
    "legal_branch_name" TEXT,
    "work_rate" DOUBLE PRECISION DEFAULT 1,
    "work_schedule" TEXT,
    "salary_amount" BIGINT,
    "salary_currency" TEXT NOT NULL DEFAULT 'KZT',
    "paper_mode" BOOLEAN NOT NULL DEFAULT false,
    "personnel_number" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_employments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_actions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'employer',
    "effective_at" DATE NOT NULL,
    "effective_to" DATE,
    "params" JSONB NOT NULL DEFAULT '{}',
    "batch_id" TEXT,
    "employment_id" TEXT,
    "applied_at" TIMESTAMP(3),
    "fail_reason" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_action_batches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "audience" JSONB NOT NULL DEFAULT '[]',
    "total" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_action_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_esutd_submissions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hr_action_id" TEXT,
    "employment_id" TEXT,
    "due_at" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMP(3),
    "submitted_by_id" TEXT,
    "external_number" TEXT,
    "correction_until" DATE,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_esutd_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_calendar_days" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "hr_work_calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_personal_doc_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "workspace_name" TEXT NOT NULL,
    "org_document_id" TEXT,
    "title" TEXT NOT NULL,
    "number" TEXT,
    "doc_type_name" TEXT,
    "file_id" TEXT NOT NULL,
    "stamped_file_id" TEXT,
    "sign_request_id" TEXT,
    "kind" TEXT NOT NULL,
    "reached_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_personal_doc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "org_document_id" TEXT NOT NULL,
    "subject_file_id" TEXT NOT NULL,
    "subject_sha256" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'one_off',
    "fix_mode" TEXT NOT NULL DEFAULT 'click',
    "status" TEXT NOT NULL DEFAULT 'active',
    "audience" JSONB NOT NULL DEFAULT '[]',
    "sign_request_id" TEXT,
    "due_at" DATE,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "doc_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_campaign_targets" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "acknowledged_at" TIMESTAMP(3),
    "subject_sha256" TEXT,
    "sign_act_id" TEXT,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_campaign_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_template_library_installs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "library_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "doc_type_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "process_id" TEXT,
    "installed_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_template_library_installs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_employments_workspace_id_status_idx" ON "hr_employments"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "hr_employments_user_id_idx" ON "hr_employments"("user_id");

-- CreateIndex
CREATE INDEX "hr_actions_workspace_id_status_effective_at_idx" ON "hr_actions"("workspace_id", "status", "effective_at");

-- CreateIndex
CREATE INDEX "hr_actions_workspace_id_user_id_created_at_idx" ON "hr_actions"("workspace_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "hr_actions_batch_id_idx" ON "hr_actions"("batch_id");

-- CreateIndex
CREATE INDEX "hr_action_batches_workspace_id_created_at_idx" ON "hr_action_batches"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "hr_esutd_submissions_workspace_id_status_due_at_idx" ON "hr_esutd_submissions"("workspace_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "hr_esutd_submissions_hr_action_id_idx" ON "hr_esutd_submissions"("hr_action_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_work_calendar_days_date_key" ON "hr_work_calendar_days"("date");

-- CreateIndex
CREATE INDEX "hr_personal_doc_records_user_id_reached_at_idx" ON "hr_personal_doc_records"("user_id", "reached_at");

-- CreateIndex
CREATE INDEX "hr_personal_doc_records_org_document_id_idx" ON "hr_personal_doc_records"("org_document_id");

-- CreateIndex
CREATE INDEX "doc_campaigns_workspace_id_status_created_at_idx" ON "doc_campaigns"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "doc_campaign_targets_user_id_status_idx" ON "doc_campaign_targets"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "doc_campaign_targets_campaign_id_user_id_key" ON "doc_campaign_targets"("campaign_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "doc_template_library_installs_workspace_id_library_key_key" ON "doc_template_library_installs"("workspace_id", "library_key");

-- CreateIndex
CREATE INDEX "org_documents_hr_action_id_idx" ON "org_documents"("hr_action_id");

-- AddForeignKey
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_actions" ADD CONSTRAINT "hr_actions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_action_batches" ADD CONSTRAINT "hr_action_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_esutd_submissions" ADD CONSTRAINT "hr_esutd_submissions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_campaigns" ADD CONSTRAINT "doc_campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_campaign_targets" ADD CONSTRAINT "doc_campaign_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "doc_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_template_library_installs" ADD CONSTRAINT "doc_template_library_installs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Партиальные уникумы (Prisma такое не выражает) — руками:
-- ============================================================

-- «Одна живая трудовая карточка на человека в организации»: повторный приём
-- после увольнения — новая строка, а параллельных двух черновиков не бывает.
CREATE UNIQUE INDEX "hr_employments_one_live"
  ON "hr_employments" ("workspace_id", "user_id")
  WHERE "status" <> 'terminated';

-- Одно событие «документ достиг человека» не пишется дважды (at-least-once
-- джобы и повторные клики); подпись и вручение — разные kind, обе живут.
CREATE UNIQUE INDEX "hr_personal_doc_records_dedup"
  ON "hr_personal_doc_records" ("user_id", "org_document_id", "kind")
  WHERE "org_document_id" IS NOT NULL;
