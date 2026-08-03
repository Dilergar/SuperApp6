-- CreateTable
CREATE TABLE "doc_types" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "number_format" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'managers',
    "to_personal_file" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_type_counters" (
    "id" TEXT NOT NULL,
    "doc_type_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_type_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_type_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "document_id" TEXT,
    "file_id" TEXT,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "self_service" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_type_id" TEXT NOT NULL,
    "template_id" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "number" TEXT,
    "numbered_at" TIMESTAMP(3),
    "subject_user_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "document_id" TEXT,
    "file_id" TEXT,
    "pdf_file_id" TEXT,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "approval_request_id" TEXT,
    "process_instance_id" TEXT,
    "parent_document_id" TEXT,
    "registry_node_id" TEXT,
    "personal_node_id" TEXT,
    "signed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doc_types_workspace_id_idx" ON "doc_types"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "doc_type_counters_doc_type_id_year_key" ON "doc_type_counters"("doc_type_id", "year");

-- CreateIndex
CREATE INDEX "doc_templates_workspace_id_status_idx" ON "doc_templates"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "doc_templates_doc_type_id_idx" ON "doc_templates"("doc_type_id");

-- CreateIndex
CREATE INDEX "org_documents_workspace_id_status_created_at_idx" ON "org_documents"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "org_documents_workspace_id_doc_type_id_idx" ON "org_documents"("workspace_id", "doc_type_id");

-- CreateIndex
CREATE INDEX "org_documents_subject_user_id_idx" ON "org_documents"("subject_user_id");

-- CreateIndex
CREATE INDEX "org_documents_template_id_idx" ON "org_documents"("template_id");

-- CreateIndex
CREATE INDEX "org_documents_parent_document_id_idx" ON "org_documents"("parent_document_id");

-- CreateIndex
CREATE INDEX "org_documents_process_instance_id_idx" ON "org_documents"("process_instance_id");

-- AddForeignKey
ALTER TABLE "doc_types" ADD CONSTRAINT "doc_types_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_type_counters" ADD CONSTRAINT "doc_type_counters_doc_type_id_fkey" FOREIGN KEY ("doc_type_id") REFERENCES "doc_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_doc_type_id_fkey" FOREIGN KEY ("doc_type_id") REFERENCES "doc_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_doc_type_id_fkey" FOREIGN KEY ("doc_type_id") REFERENCES "doc_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "doc_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_parent_document_id_fkey" FOREIGN KEY ("parent_document_id") REFERENCES "org_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
