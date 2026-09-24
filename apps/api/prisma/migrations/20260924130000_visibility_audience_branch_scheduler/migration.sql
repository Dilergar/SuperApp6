-- ============================================================
-- core/visibility — адресат `branch_scheduler` («ведёт график объекта») в CHECK правил
-- ============================================================
-- Реестр shared (`VISIBILITY_WORKSPACE_AUDIENCE_KINDS`) и Zod принимали `branch_scheduler`,
-- а CHECK таблицы `visibility_rules` его не знал: правило с этим адресатом падало на вставке
-- (23514 → 500). Список CHECK = `VISIBILITY_AUDIENCE_KINDS` целиком; страж `check:visibility`
-- сверяет последнее определение этого CHECK в миграциях с реестром.

ALTER TABLE "visibility_rules" DROP CONSTRAINT "visibility_rules_audience_kind_check";
ALTER TABLE "visibility_rules" ADD CONSTRAINT "visibility_rules_audience_kind_check" CHECK ("audience_kind" IN (
  'role', 'department', 'position', 'branch', 'manager_of', 'branch_head_of', 'branch_payroll', 'branch_scheduler',
  'everybody', 'circle_all', 'circle', 'colleagues', 'user'
));
