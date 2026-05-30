-- CreateTable
CREATE TABLE "relation_tuples" (
    "id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "subject_relation" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relation_tuples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relation_tuples_resource_type_resource_id_relation_idx" ON "relation_tuples"("resource_type", "resource_id", "relation");

-- CreateIndex
CREATE INDEX "relation_tuples_subject_type_subject_id_idx" ON "relation_tuples"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "relation_tuples_subject_type_subject_id_resource_type_relat_idx" ON "relation_tuples"("subject_type", "subject_id", "resource_type", "relation");

-- CreateIndex
CREATE UNIQUE INDEX "relation_tuples_resource_type_resource_id_relation_subject__key" ON "relation_tuples"("resource_type", "resource_id", "relation", "subject_type", "subject_id", "subject_relation");
