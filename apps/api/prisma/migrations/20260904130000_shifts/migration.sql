-- ============================================================
-- ГРАФИК СМЕН: шаблон («Утро 09–17») → ротация (2/2) → ПЛАН (Shift) → ФАКТ
-- (ShiftAttendance). План и факт — РАЗНЫЕ записи: «кто закрыл» ≠ «кому назначена».
-- Экземпляр смены ЗАМОРАЖИВАЕТ время в себе: правка шаблона план не трогает.
-- ============================================================

CREATE TABLE "shift_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "name" TEXT NOT NULL,
    "glyph" TEXT,
    "color" TEXT,
    "start_min" INTEGER NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "break_min" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shift_templates_workspace_id_branch_id_idx" ON "shift_templates"("workspace_id", "branch_id");
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_shift_template_id_fkey"
  FOREIGN KEY ("shift_template_id") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "staffing_positions_shift_template_id_idx" ON "staffing_positions"("shift_template_id");

CREATE TABLE "shift_patterns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "assignment_id" TEXT,
    "staffing_position_id" TEXT,
    "name" TEXT NOT NULL,
    "anchor_date" DATE NOT NULL,
    "cycle" JSONB NOT NULL,
    "active_from" DATE NOT NULL,
    "active_to" DATE,
    "horizon_days" INTEGER NOT NULL DEFAULT 42,
    "archived_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shift_patterns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shift_patterns_workspace_id_branch_id_idx" ON "shift_patterns"("workspace_id", "branch_id");
CREATE INDEX "shift_patterns_assignment_id_idx" ON "shift_patterns"("assignment_id");
CREATE INDEX "shift_patterns_staffing_position_id_idx" ON "shift_patterns"("staffing_position_id");
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "staff_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_staffing_position_id_fkey"
  FOREIGN KEY ("staffing_position_id") REFERENCES "staffing_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Ротация принадлежит ЧЕЛОВЕКУ или ОТКРЫТЫМ слотам единицы — ровно одно.
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_target_xor_check"
  CHECK (("assignment_id" IS NULL) <> ("staffing_position_id" IS NULL));
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_dates_check"
  CHECK ("active_to" IS NULL OR "active_to" >= "active_from");

CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "staffing_position_id" TEXT,
    "position_id" TEXT NOT NULL,
    "assignment_id" TEXT,
    "user_id" TEXT,
    "local_date" DATE NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "break_min" INTEGER NOT NULL DEFAULT 0,
    "template_id" TEXT,
    "pattern_id" TEXT,
    "pattern_slot" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shifts_workspace_id_branch_id_local_date_idx" ON "shifts"("workspace_id", "branch_id", "local_date");
CREATE INDEX "shifts_user_id_starts_at_idx" ON "shifts"("user_id", "starts_at");
CREATE INDEX "shifts_pattern_id_local_date_idx" ON "shifts"("pattern_id", "local_date");
CREATE INDEX "shifts_assignment_id_idx" ON "shifts"("assignment_id");
CREATE INDEX "shifts_staffing_position_id_idx" ON "shifts"("staffing_position_id");
CREATE INDEX "shifts_template_id_idx" ON "shifts"("template_id");
CREATE INDEX "shifts_position_id_idx" ON "shifts"("position_id");

ALTER TABLE "shifts" ADD CONSTRAINT "shifts_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: объект со сменами не удаляется молча (прикладной 409).
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_staffing_position_id_fkey"
  FOREIGN KEY ("staffing_position_id") REFERENCES "staffing_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_position_id_fkey"
  FOREIGN KEY ("position_id") REFERENCES "staff_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "staff_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_pattern_id_fkey"
  FOREIGN KEY ("pattern_id") REFERENCES "shift_patterns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "shift_attendance" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "shift_id" TEXT,
    "user_id" TEXT NOT NULL,
    "local_date" DATE NOT NULL,
    "outcome" TEXT NOT NULL,
    "late_min" INTEGER NOT NULL DEFAULT 0,
    "actual_start_at" TIMESTAMP(3),
    "actual_end_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "source_ref" TEXT,
    "marked_by_id" TEXT,
    "marked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shift_attendance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shift_attendance_workspace_id_branch_id_local_date_idx" ON "shift_attendance"("workspace_id", "branch_id", "local_date");
CREATE INDEX "shift_attendance_user_id_local_date_idx" ON "shift_attendance"("user_id", "local_date");
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_shift_id_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- РУКОПИСНЫЕ ОГРАНИЧЕНИЯ (Prisma их не выражает).
-- ============================================================

-- Идемпотентная генерация по ротации: повтор джоба не плодит смены.
CREATE UNIQUE INDEX "shifts_pattern_slot_key"
  ON "shifts"("pattern_id", "local_date", "pattern_slot") WHERE "pattern_id" IS NOT NULL;

-- Человек не может стоять на двух пересекающихся сменах (отменённые не считаются).
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_no_overlap"
  EXCLUDE USING gist ("user_id" WITH =, tsrange("starts_at", "ends_at") WITH &&)
  WHERE ("user_id" IS NOT NULL AND "status" <> 'cancelled');

-- Один факт на смену (повторная отметка ПРАВИТ запись, а не плодит).
CREATE UNIQUE INDEX "shift_attendance_shift_key"
  ON "shift_attendance"("shift_id") WHERE "shift_id" IS NOT NULL;
