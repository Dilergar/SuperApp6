-- core/lifecycle — ревью: индексы под общую пачку раннера сроков.
--
-- Общая пачка — `WHERE <колонка срока> < $срок [AND фильтр] ORDER BY <колонка срока> LIMIT n
-- FOR UPDATE SKIP LOCKED`. Порядок «старейшие первыми» даёт только b-tree, ведущий колонкой
-- срока (или вторая колонка после единственного значения фильтра). Страж пропускал индекс,
-- ведущий колонкой ВЛАДЕЛЬЦА, — у этих политик каждая пачка читала бы и сортировала таблицу
-- целиком: на миллионах строк `statement_timeout 5 с` → 5 таймаутов → пауза 10 минут → срок не
-- принуждается никогда (табель, заказы, «недавние» Диска растут без границы). Страж
-- `check:lifecycle` теперь требует такой индекс у каждого конечного правила общей пачки.
--
-- Таблицы не из списка «больших» стража миграций (запись умеренная); прода нет — обычный
-- CREATE INDEX в одном файле. На живом проде такие индексы — `db-online-ddl.cjs` (CONCURRENTLY).
SET lock_timeout = '3s';
SET statement_timeout = '600s';

CREATE INDEX IF NOT EXISTS "share_links_revoked_at_idx" ON "share_links" ("revoked_at");
CREATE INDEX IF NOT EXISTS "share_link_guests_last_verified_at_idx" ON "share_link_guests" ("last_verified_at");
CREATE INDEX IF NOT EXISTS "platform_sessions_revoked_at_idx" ON "platform_sessions" ("revoked_at");
CREATE INDEX IF NOT EXISTS "analytics_identity_links_linked_at_idx" ON "analytics_identity_links" ("linked_at");
CREATE INDEX IF NOT EXISTS "api_keys_revoked_at_idx" ON "api_keys" ("revoked_at");
CREATE INDEX IF NOT EXISTS "security_alerts_status_updated_at_idx" ON "security_alerts" ("status", "updated_at");
CREATE INDEX IF NOT EXISTS "lifecycle_erasure_requests_completed_at_idx" ON "lifecycle_erasure_requests" ("completed_at");
CREATE INDEX IF NOT EXISTS "scheduled_messages_updated_at_idx" ON "scheduled_messages" ("updated_at");
CREATE INDEX IF NOT EXISTS "shift_attendance_local_date_idx" ON "shift_attendance" ("local_date");
CREATE INDEX IF NOT EXISTS "orders_closed_at_idx" ON "orders" ("closed_at");
CREATE INDEX IF NOT EXISTS "drive_recents_opened_at_idx" ON "drive_recents" ("opened_at");
