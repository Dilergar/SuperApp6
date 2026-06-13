-- AlterTable
ALTER TABLE "process_instances" ADD COLUMN     "trigger_type" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "process_step_runs" ADD COLUMN     "join_arrivals" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "process_triggers" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "webhook_token" TEXT,
    "run_as_user_id" TEXT NOT NULL,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_credentials" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "process_triggers_webhook_token_key" ON "process_triggers"("webhook_token");

-- CreateIndex
CREATE INDEX "process_triggers_workspace_id_type_enabled_idx" ON "process_triggers"("workspace_id", "type", "enabled");

-- CreateIndex
CREATE INDEX "process_triggers_type_enabled_next_run_at_idx" ON "process_triggers"("type", "enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "process_triggers_definition_id_idx" ON "process_triggers"("definition_id");

-- CreateIndex
CREATE INDEX "process_credentials_workspace_id_idx" ON "process_credentials"("workspace_id");

-- AddForeignKey
ALTER TABLE "process_triggers" ADD CONSTRAINT "process_triggers_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "process_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
