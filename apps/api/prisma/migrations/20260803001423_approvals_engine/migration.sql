-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "ref_title" TEXT NOT NULL,
    "ref_icon" TEXT,
    "workspace_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "origin_type" TEXT,
    "origin_ref" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "assignee_type" TEXT NOT NULL,
    "assignee_id" TEXT NOT NULL,
    "assignee_label" TEXT,
    "rule" TEXT NOT NULL DEFAULT 'any',
    "awaiting_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activated_at" TIMESTAMP(3),
    "deadline_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "subject_sha256" TEXT,
    "signature_kind" TEXT NOT NULL DEFAULT 'internal',
    "ip" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_requests_workspace_id_status_created_at_idx" ON "approval_requests"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_created_by_id_status_created_at_idx" ON "approval_requests"("created_by_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_ref_type_ref_id_idx" ON "approval_requests"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "approval_requests_origin_type_origin_ref_idx" ON "approval_requests"("origin_type", "origin_ref");

-- CreateIndex
CREATE INDEX "approval_steps_status_assignee_type_assignee_id_idx" ON "approval_steps"("status", "assignee_type", "assignee_id");

-- CreateIndex
CREATE INDEX "approval_steps_request_id_order_idx" ON "approval_steps"("request_id", "order");

-- CreateIndex
CREATE INDEX "approval_decisions_user_id_decided_at_idx" ON "approval_decisions"("user_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_decisions_step_id_user_id_key" ON "approval_decisions"("step_id", "user_id");

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "approval_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
