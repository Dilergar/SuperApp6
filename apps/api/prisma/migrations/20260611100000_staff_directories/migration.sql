-- Staff («Сотрудники»): справочники Должность/Отдел/Филиал + назначения.
-- Порядок важен: сначала новые таблицы, затем ПЕРЕНОС данных из текстовых колонок
-- workspace_members.position/department, и только потом их дроп.

-- CreateTable
CREATE TABLE "staff_departments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_positions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" TEXT,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_branches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_assignments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'training',
    "assigned_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_departments_workspace_id_idx" ON "staff_departments"("workspace_id");
CREATE UNIQUE INDEX "staff_departments_workspace_id_name_key" ON "staff_departments"("workspace_id", "name");
CREATE INDEX "staff_positions_workspace_id_idx" ON "staff_positions"("workspace_id");
CREATE INDEX "staff_positions_department_id_idx" ON "staff_positions"("department_id");
CREATE UNIQUE INDEX "staff_positions_workspace_id_name_key" ON "staff_positions"("workspace_id", "name");
CREATE INDEX "staff_branches_workspace_id_idx" ON "staff_branches"("workspace_id");
CREATE UNIQUE INDEX "staff_branches_workspace_id_name_key" ON "staff_branches"("workspace_id", "name");
CREATE INDEX "staff_assignments_workspace_id_user_id_idx" ON "staff_assignments"("workspace_id", "user_id");
CREATE INDEX "staff_assignments_position_id_idx" ON "staff_assignments"("position_id");
CREATE INDEX "staff_assignments_branch_id_idx" ON "staff_assignments"("branch_id");
CREATE UNIQUE INDEX "staff_assignments_workspace_id_user_id_position_id_branch_i_key" ON "staff_assignments"("workspace_id", "user_id", "position_id", "branch_id");
-- Composite unique above treats NULL branch_id as distinct (Postgres) — close the gap:
CREATE UNIQUE INDEX "staff_assignments_user_position_nobranch_key" ON "staff_assignments"("workspace_id", "user_id", "position_id") WHERE "branch_id" IS NULL;

-- AddForeignKey
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "staff_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "staff_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "staff_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- ДАННЫЕ: лестница ролей и перенос текстовых должностей/отделов
-- ============================================================

-- 1) Роль guest → contractor («Подрядчик», Коллаб-модель). Лестница:
--    contractor < trainee < staff < manager < admin < owner.
UPDATE "user_roles" SET "role" = 'contractor'
WHERE "role" = 'guest' AND "context" = 'workspace';

-- Pending-приглашения со старым выбором роли: новая политика — найм всегда в Стажёра.
UPDATE "workspace_invitations" SET "role" = 'trainee' WHERE "status" = 'pending';

-- 2) Отделы из distinct текстов workspace_members.department.
INSERT INTO "staff_departments" ("id", "workspace_id", "name", "updated_at")
SELECT gen_random_uuid(), m."workspace_id", trim(m."department"), CURRENT_TIMESTAMP
FROM "workspace_members" m
WHERE m."department" IS NOT NULL AND trim(m."department") <> ''
GROUP BY m."workspace_id", trim(m."department");

-- 3) Должности из distinct текстов workspace_members.position; отдел должности —
--    отдел любого её носителя (MIN — детерминированно), если он указывал оба поля.
INSERT INTO "staff_positions" ("id", "workspace_id", "name", "department_id", "updated_at")
SELECT gen_random_uuid(), p."workspace_id", p."pos_name",
       (SELECT d."id" FROM "staff_departments" d
        WHERE d."workspace_id" = p."workspace_id" AND d."name" = p."dep_name"),
       CURRENT_TIMESTAMP
FROM (
  SELECT m."workspace_id", trim(m."position") AS "pos_name",
         MIN(trim(m."department")) FILTER (WHERE m."department" IS NOT NULL AND trim(m."department") <> '') AS "dep_name"
  FROM "workspace_members" m
  WHERE m."position" IS NOT NULL AND trim(m."position") <> ''
  GROUP BY m."workspace_id", trim(m."position")
) p;

-- 4) Назначения для членов с должностью-текстом. Действующие сотрудники считаются
--    аттестованными (стажировка — для новых наймов).
INSERT INTO "staff_assignments" ("id", "workspace_id", "user_id", "position_id", "status", "updated_at")
SELECT gen_random_uuid(), m."workspace_id", m."user_id", sp."id", 'certified', CURRENT_TIMESTAMP
FROM "workspace_members" m
JOIN "staff_positions" sp
  ON sp."workspace_id" = m."workspace_id" AND sp."name" = trim(m."position")
WHERE m."position" IS NOT NULL AND trim(m."position") <> '';

-- ============================================================
-- Дроп текстовых колонок (данные уже перенесены)
-- ============================================================

-- AlterTable
ALTER TABLE "workspace_invitations" DROP COLUMN "department",
DROP COLUMN "position",
ADD COLUMN     "branch_id" TEXT,
ADD COLUMN     "position_id" TEXT,
ALTER COLUMN "role" SET DEFAULT 'trainee';

-- AlterTable
ALTER TABLE "workspace_members" DROP COLUMN "department",
DROP COLUMN "position";

-- FK приглашений на справочники
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "staff_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
