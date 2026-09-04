-- ============================================================
-- ОБЪЕКТЫ: StaffBranch превращается из плоского справочника «Филиалы» в ДЕРЕВО
-- физических площадок (площадка → здание → этаж → зона), с юрлицом, поясом и
-- настройками смен. Модель НЕ переименовывается: ключ `branch` в access/audiences/
-- tuples и все ссылки на branchId сохраняются, меняется только UI-имя («Объект»).
-- ============================================================

ALTER TABLE "staff_branches" ADD COLUMN "parent_id" TEXT;
ALTER TABLE "staff_branches" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'site';
ALTER TABLE "staff_branches" ADD COLUMN "legal_entity_id" TEXT;
ALTER TABLE "staff_branches" ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'Asia/Almaty';
ALTER TABLE "staff_branches" ADD COLUMN "glyph" TEXT;
-- Материализованные предки (корень ПЕРВЫМ, без себя) — предписанный доками паттерн
-- (Диск, closure отделов): «одно условие в SQL» и для поддерева, и для прав по предкам.
ALTER TABLE "staff_branches" ADD COLUMN "ancestor_ids" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "staff_branches" ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0;
-- Правила смен = ДАННЫЕ объекта: {minRestMin, maxShiftMin, lateToleranceMin, weekStartsOn, accountingPeriod}
ALTER TABLE "staff_branches" ADD COLUMN "schedule_settings" JSONB;
-- Закрытая точка: история, смены и активы остаются, объект не предлагается в новых формах.
ALTER TABLE "staff_branches" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "staff_branches_workspace_id_parent_id_idx" ON "staff_branches"("workspace_id", "parent_id");
CREATE INDEX "staff_branches_legal_entity_id_idx" ON "staff_branches"("legal_entity_id");

-- Restrict: узел с детьми не удаляется — прикладной 409 «сначала перенесите вложенные».
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "staff_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- SetNull: архив/удаление юрлица не рвёт объект — он вернётся к наследованию.
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_legal_entity_id_fkey"
  FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- РУКОПИСНОЕ (Prisma не выражает GIN по scalar-массиву).
-- Один индекс обслуживает и «всё поддерево узла» (ancestor_ids @> ARRAY[id]),
-- и «мои объекты по грантам предков» (ancestor_ids && $granted).
-- ============================================================
CREATE INDEX "staff_branches_ancestor_ids_gin" ON "staff_branches" USING GIN ("ancestor_ids");
