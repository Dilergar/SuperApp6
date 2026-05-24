/*
  Warnings:

  - You are about to drop the column `role` on the `workspace_members` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `workspaces` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "workspace_members" DROP COLUMN "role";

-- AlterTable
ALTER TABLE "workspaces" DROP COLUMN "type";

-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "to_user_id" TEXT,
    "to_phone" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "position" TEXT,
    "department" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_idx" ON "workspace_invitations"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_invitations_to_user_id_idx" ON "workspace_invitations"("to_user_id");

-- CreateIndex
CREATE INDEX "workspace_invitations_to_phone_idx" ON "workspace_invitations"("to_phone");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_status_idx" ON "workspace_invitations"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_to_user_id_status_idx" ON "workspace_invitations"("to_user_id", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_status_expires_at_idx" ON "workspace_invitations"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
