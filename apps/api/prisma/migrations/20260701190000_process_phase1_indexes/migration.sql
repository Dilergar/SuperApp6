-- P4: бэкфилл event_type из config для уже опубликованных event-триггеров
-- (роутер теперь фильтрует по колонке, а не по JSONB-path).
UPDATE "process_triggers"
  SET "event_type" = "config"->>'eventType'
  WHERE "type" = 'event' AND "event_type" IS NULL;

-- P6: «Входящие» — быстрый скан claimable-шагов очереди отдела.
-- Партиал-индекс (WHERE) не выразим в schema.prisma — prisma migrate игнорирует его на diff
-- (тот же приём, что ledger_pending_resolution_unique / process_join_unique).
CREATE INDEX "process_step_runs_claimable_idx"
  ON "process_step_runs"("department_id")
  WHERE "status" = 'active' AND "task_id" IS NULL AND "department_id" IS NOT NULL;
