-- Пересечение смен одного человека — ошибка ВНУТРИ организации, а не между ними.
-- Без workspace_id ограничение течёт сквозь B2B-изоляцию: смена в организации Б
-- отвергалась из-за смены в организации А, которую тамошний управляющий не видит
-- (и не может ни объяснить отказ, ни устранить причину). Совместительство между
-- работодателями платформа не полицействует.
ALTER TABLE "shifts" DROP CONSTRAINT IF EXISTS "shifts_user_no_overlap";
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_no_overlap"
  EXCLUDE USING gist (
    "workspace_id" WITH =,
    "user_id" WITH =,
    tsrange("starts_at", "ends_at") WITH &&
  )
  WHERE ("user_id" IS NOT NULL AND "status" <> 'cancelled');
