-- ============================================================
-- Орг. структура (B2B): головы отдела/объекта, переопределение подчинения,
-- заместители, основной объект, обязательный объект у назначения, основное место.
-- ============================================================

-- ---------- Новые колонки ----------
ALTER TABLE "staff_departments" ADD COLUMN "head_position_id" TEXT;

ALTER TABLE "staff_positions" ADD COLUMN "reports_to_position_id" TEXT,
ADD COLUMN "glyph" TEXT;

ALTER TABLE "staff_branches" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "head_position_id" TEXT;

ALTER TABLE "staff_assignments" ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- ---------- Основной объект: у каждой организации ровно один ----------
-- Организации без объектов получают основной объект с названием организации и
-- юрадресом из реквизитов (если заполнен). Дубль имени в пределах организации
-- невозможен: объектов у неё нет вовсе.
INSERT INTO "staff_branches" ("id", "workspace_id", "name", "address", "note", "sort_order", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid()::text, w."id", w."name", r."legal_address", NULL, 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "workspaces" w
LEFT JOIN "workspace_requisites" r ON r."workspace_id" = w."id"
WHERE NOT EXISTS (SELECT 1 FROM "staff_branches" b WHERE b."workspace_id" = w."id");

-- У организаций с объектами основным становится первый по дате создания.
UPDATE "staff_branches" b SET "is_default" = true
WHERE b."id" = (
  SELECT x."id" FROM "staff_branches" x
  WHERE x."workspace_id" = b."workspace_id"
  ORDER BY x."created_at" ASC, x."id" ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "staff_branches" y WHERE y."workspace_id" = b."workspace_id" AND y."is_default");

-- ---------- Назначения без объекта → в основной объект ----------
-- Если у человека уже есть такое же назначение в основном объекте — «без объекта»
-- становится дублем и снимается (иначе уникум (ws,user,position,branch) не пройдёт).
DELETE FROM "staff_assignments" a
USING "staff_branches" d
WHERE a."branch_id" IS NULL
  AND d."workspace_id" = a."workspace_id" AND d."is_default"
  AND EXISTS (
    SELECT 1 FROM "staff_assignments" b
    WHERE b."workspace_id" = a."workspace_id" AND b."user_id" = a."user_id"
      AND b."position_id" = a."position_id" AND b."branch_id" = d."id"
  );

UPDATE "staff_assignments" a SET "branch_id" = d."id"
FROM "staff_branches" d
WHERE a."branch_id" IS NULL AND d."workspace_id" = a."workspace_id" AND d."is_default";

-- Состояние «без объекта» исчезает: партиальный уникум под NULL больше не нужен.
DROP INDEX IF EXISTS "staff_assignments_user_position_nobranch_key";

ALTER TABLE "staff_assignments" DROP CONSTRAINT "staff_assignments_branch_id_fkey";
ALTER TABLE "staff_assignments" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- Основное место: самое раннее назначение человека ----------
UPDATE "staff_assignments" a SET "is_primary" = true
WHERE a."id" = (
  SELECT x."id" FROM "staff_assignments" x
  WHERE x."workspace_id" = a."workspace_id" AND x."user_id" = a."user_id"
  ORDER BY x."created_at" ASC, x."id" ASC
  LIMIT 1
);

-- ---------- Заместители ----------
CREATE TABLE "staff_deputies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "deputy_position_id" TEXT,
    "deputy_user_id" TEXT,
    "starts_on" DATE,
    "ends_on" DATE,
    "note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_deputies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staff_deputies_workspace_id_idx" ON "staff_deputies"("workspace_id");
CREATE INDEX "staff_deputies_position_id_idx" ON "staff_deputies"("position_id");
CREATE INDEX "staff_deputies_deputy_position_id_idx" ON "staff_deputies"("deputy_position_id");
CREATE INDEX "staff_deputies_deputy_user_id_idx" ON "staff_deputies"("deputy_user_id");

ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "staff_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_deputy_position_id_fkey" FOREIGN KEY ("deputy_position_id") REFERENCES "staff_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_deputy_user_id_fkey" FOREIGN KEY ("deputy_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- FK голов и переопределения ----------
CREATE INDEX "staff_departments_head_position_id_idx" ON "staff_departments"("head_position_id");
CREATE INDEX "staff_positions_reports_to_position_id_idx" ON "staff_positions"("reports_to_position_id");
CREATE INDEX "staff_branches_head_position_id_idx" ON "staff_branches"("head_position_id");

ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_head_position_id_fkey" FOREIGN KEY ("head_position_id") REFERENCES "staff_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_reports_to_position_id_fkey" FOREIGN KEY ("reports_to_position_id") REFERENCES "staff_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_head_position_id_fkey" FOREIGN KEY ("head_position_id") REFERENCES "staff_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- РУКОПИСНЫЕ ОГРАНИЧЕНИЯ (Prisma их не выражает — зеркалятся комментами в schema.prisma;
-- `prisma db pull` их не сохранит, `db push` запрещён).
-- ============================================================

-- Ровно один основной объект на организацию.
CREATE UNIQUE INDEX "staff_branches_default_per_workspace_key" ON "staff_branches"("workspace_id") WHERE "is_default";

-- Ровно одно основное место у человека в организации.
CREATE UNIQUE INDEX "staff_assignments_primary_per_user_key" ON "staff_assignments"("workspace_id", "user_id") WHERE "is_primary";

-- Заместитель: ровно одна цель — должность XOR человек.
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_target_xor_check"
  CHECK (("deputy_position_id" IS NULL) <> ("deputy_user_id" IS NULL));

-- Период: конец не раньше начала.
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_dates_check"
  CHECK ("starts_on" IS NULL OR "ends_on" IS NULL OR "ends_on" >= "starts_on");

-- Должность не замещает сама себя.
ALTER TABLE "staff_deputies" ADD CONSTRAINT "staff_deputies_not_self_check"
  CHECK ("deputy_position_id" IS NULL OR "deputy_position_id" <> "position_id");

-- Дедуп двойного клика (не бизнес-правило: пересечения периодов разрешены).
CREATE UNIQUE INDEX "staff_deputies_dedup_key" ON "staff_deputies" (
  "position_id",
  COALESCE("branch_id", ''),
  COALESCE("deputy_position_id", ''),
  COALESCE("deputy_user_id", ''),
  COALESCE("starts_on", DATE '0001-01-01'),
  COALESCE("ends_on", DATE '9999-12-31')
);
