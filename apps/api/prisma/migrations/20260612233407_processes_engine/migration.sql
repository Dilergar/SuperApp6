-- AlterTable
ALTER TABLE "workspace_invitations" ALTER COLUMN "branch_ids" DROP DEFAULT;

-- CreateTable
CREATE TABLE "process_definitions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'team',
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_version_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_versions" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "document" JSONB NOT NULL,
    "compiled" JSONB,
    "created_by_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_instances" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "variables" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_by_id" TEXT NOT NULL,
    "wake_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "process_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_step_runs" (
    "id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "outcome" TEXT,
    "output" JSONB,
    "error" TEXT,
    "task_id" TEXT,
    "assignee_id" TEXT,
    "source_step_id" TEXT,

    CONSTRAINT "process_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "process_definitions_workspace_id_status_idx" ON "process_definitions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "process_versions_definition_id_status_idx" ON "process_versions"("definition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "process_versions_definition_id_version_key" ON "process_versions"("definition_id", "version");

-- CreateIndex
CREATE INDEX "process_instances_workspace_id_status_idx" ON "process_instances"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "process_instances_definition_id_status_idx" ON "process_instances"("definition_id", "status");

-- CreateIndex
CREATE INDEX "process_instances_started_by_id_idx" ON "process_instances"("started_by_id");

-- CreateIndex
CREATE INDEX "process_instances_wake_at_idx" ON "process_instances"("wake_at");

-- CreateIndex
CREATE UNIQUE INDEX "process_step_runs_task_id_key" ON "process_step_runs"("task_id");

-- CreateIndex
CREATE INDEX "process_step_runs_instance_id_status_idx" ON "process_step_runs"("instance_id", "status");

-- CreateIndex
CREATE INDEX "process_step_runs_assignee_id_idx" ON "process_step_runs"("assignee_id");

-- AddForeignKey
ALTER TABLE "process_versions" ADD CONSTRAINT "process_versions_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "process_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "process_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "process_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_step_runs" ADD CONSTRAINT "process_step_runs_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "process_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
