-- core/webhooks: серия провалов endpoint'а во времени.
-- failing_since   — начало текущей серии (автоотключение: порог штук И возраст серии);
-- last_failure_at — последний провал / взятая пробная доставка (предохранитель мёртвого адреса).
ALTER TABLE "webhook_endpoints"
  ADD COLUMN "failing_since" TIMESTAMP(3),
  ADD COLUMN "last_failure_at" TIMESTAMP(3);
