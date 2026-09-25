SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Заморозку платформы (команда Кабинета `lifecycle.hold.create`) код пишет с `created_by_kind =
-- 'platform'`, а CHECK разрешал `'platform_staff'` — любая заморозка платформы падала нарушением
-- ограничения (23514). CHECK = перечисление shared `LIFECYCLE_HOLD_CREATOR_KINDS` (сверку держит
-- verify-lifecycle.cjs). Строк `platform_staff` нет (вставить их было нечем). Таблица заморозок
-- малая — CHECK пересоздаётся одним оператором.
ALTER TABLE "lifecycle_holds" DROP CONSTRAINT "lifecycle_holds_kind_check";
ALTER TABLE "lifecycle_holds" ADD CONSTRAINT "lifecycle_holds_kind_check"
  CHECK ("created_by_kind" IN ('user', 'platform'));
