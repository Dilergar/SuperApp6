-- ============================================================
-- ШТАТНОЕ РАСПИСАНИЕ: штатная единица (должность × объект) существует и вакантной,
-- назначение ДАТИРУЕТСЯ (человек уходит и возвращается — это разные строки),
-- ставки версионируются (SCD2, append-only: «сколько платили в марте» обязано
-- отвечаться через год).
-- ============================================================

-- ---------- 1. Датирование назначений ----------
ALTER TABLE "staff_assignments" ADD COLUMN "starts_on" DATE;
ALTER TABLE "staff_assignments" ADD COLUMN "ends_on" DATE;
ALTER TABLE "staff_assignments" ADD COLUMN "rate_share" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "staff_assignments" ADD COLUMN "staffing_position_id" TEXT;

-- Уникум «человек × должность × объект» снимается: закрытое назначение ОСТАЁТСЯ
-- в истории, а повторный приём на ту же позицию — новая строка.
DROP INDEX IF EXISTS "staff_assignments_workspace_id_user_id_position_id_branch_id_key";

-- Конец не раньше начала.
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_dates_check"
  CHECK ("ends_on" IS NULL OR "starts_on" IS NULL OR "ends_on" >= "starts_on");

-- Пересечение периодов одной и той же связки — ошибка данных, а не UI:
-- держим её в БД (EXCLUDE по диапазону дат), 23P01 → прикладной 409.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_no_overlap"
  EXCLUDE USING gist (
    "workspace_id" WITH =,
    "user_id" WITH =,
    "position_id" WITH =,
    "branch_id" WITH =,
    daterange(COALESCE("starts_on", '-infinity'), COALESCE("ends_on", 'infinity'), '[]') WITH &&
  );

CREATE INDEX "staff_assignments_staffing_position_id_idx" ON "staff_assignments"("staffing_position_id");
CREATE INDEX "staff_assignments_workspace_id_ends_on_idx" ON "staff_assignments"("workspace_id", "ends_on");

-- ---------- 2. Штатная единица ----------
CREATE TABLE "staffing_positions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "shift_template_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "staffing_positions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "staffing_positions_workspace_id_branch_id_idx" ON "staffing_positions"("workspace_id", "branch_id");
CREATE INDEX "staffing_positions_position_id_idx" ON "staffing_positions"("position_id");

ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: объект со штаткой не удаляется молча (прикладной 409).
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "staff_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_position_id_fkey"
  FOREIGN KEY ("position_id") REFERENCES "staff_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_staffing_position_id_fkey"
  FOREIGN KEY ("staffing_position_id") REFERENCES "staffing_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- 3. Версии ставок (SCD2) ----------
CREATE TABLE "staff_rates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "staffing_position_id" TEXT,
    "assignment_id" TEXT,
    "rate_type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_rates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "staff_rates_assignment_id_effective_from_idx" ON "staff_rates"("assignment_id", "effective_from");
CREATE INDEX "staff_rates_staffing_position_id_effective_from_idx" ON "staff_rates"("staffing_position_id", "effective_from");
CREATE INDEX "staff_rates_workspace_id_idx" ON "staff_rates"("workspace_id");

ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_staffing_position_id_fkey"
  FOREIGN KEY ("staffing_position_id") REFERENCES "staffing_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "staff_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- РУКОПИСНЫЕ ОГРАНИЧЕНИЯ (Prisma их не выражает).
-- ============================================================

-- Одна ЖИВАЯ штатная единица на пару «объект × должность».
CREATE UNIQUE INDEX "staffing_positions_live_key"
  ON "staffing_positions"("branch_id", "position_id") WHERE "archived_at" IS NULL;

-- Ставка принадлежит РОВНО одному: штатной единице (плановая) ИЛИ назначению (факт).
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_target_xor_check"
  CHECK (("staffing_position_id" IS NULL) <> ("assignment_id" IS NULL));

-- Период версии: конец не раньше начала.
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_dates_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- Одна версия ставки на дату у каждой цели (двойной клик не плодит вилку).
CREATE UNIQUE INDEX "staff_rates_assignment_from_key"
  ON "staff_rates"("assignment_id", "effective_from") WHERE "assignment_id" IS NOT NULL;
CREATE UNIQUE INDEX "staff_rates_staffing_from_key"
  ON "staff_rates"("staffing_position_id", "effective_from") WHERE "staffing_position_id" IS NOT NULL;
