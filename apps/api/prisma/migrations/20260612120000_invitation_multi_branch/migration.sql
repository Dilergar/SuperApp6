-- Приглашение сотрудника: несколько филиалов «с порога» (один сотрудник может
-- обслуживать несколько). branchId (один, FK) → branchIds (scalar-массив).
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_branch_id_fkey";
ALTER TABLE "workspace_invitations" ADD COLUMN "branch_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Перенос существующих одиночных филиалов в массив.
UPDATE "workspace_invitations" SET "branch_ids" = ARRAY["branch_id"] WHERE "branch_id" IS NOT NULL;

ALTER TABLE "workspace_invitations" DROP COLUMN "branch_id";
