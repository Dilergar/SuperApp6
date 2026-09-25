SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Заявка на стирание ждёт снятия заморозки (Э4, LIFECYCLE_ERASURE_STATUSES): статус `held`.
-- Таблица заявок малая (одна строка на удаление) — CHECK пересоздаётся одним оператором.
ALTER TABLE "lifecycle_erasure_requests" DROP CONSTRAINT "lifecycle_erasure_requests_status_check";
ALTER TABLE "lifecycle_erasure_requests" ADD CONSTRAINT "lifecycle_erasure_requests_status_check"
  CHECK ("status" IN ('scheduled', 'held', 'running', 'hot_purged', 'keys_destroyed', 'completed', 'cancelled', 'failed'));
