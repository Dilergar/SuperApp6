-- ============================================================
-- core/analytics — измерение «внутренний аккаунт» в роллапах
-- ============================================================
-- Запросы Кабинета по умолчанию исключают сотрудников платформы и тестовые номера,
-- а тумблер «включая внутренние аккаунты» возвращает их. Без отдельного измерения
-- роллапы умели бы только одно из двух. Уникумы с NULL-измерениями пересобираются
-- руками (`NULLS NOT DISTINCT`, Prisma не выражает).

ALTER TABLE "analytics_rollup_event_day" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "analytics_rollup_actor_day" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "analytics_rollup_session_day" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "analytics_rollup_event_day_dims_key";
CREATE UNIQUE INDEX "analytics_rollup_event_day_dims_key" ON "analytics_rollup_event_day"
  ("day", "workspace_id", "service", "event_key", "platform", "plan_key", "internal") NULLS NOT DISTINCT;

DROP INDEX "analytics_rollup_session_day_dims_key";
CREATE UNIQUE INDEX "analytics_rollup_session_day_dims_key" ON "analytics_rollup_session_day"
  ("day", "workspace_id", "platform", "internal") NULLS NOT DISTINCT;
