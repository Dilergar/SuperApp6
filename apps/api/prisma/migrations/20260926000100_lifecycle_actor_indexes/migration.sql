-- core/lifecycle Э3: след стёртого актора (псевдонимизация хроники и снимков уведомлений) — пачки
-- по actor_id. Частичные индексы: у системных записей актора нет.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

CREATE INDEX "chatter_entries_actor_id_idx" ON "chatter_entries" ("actor_id") WHERE "actor_id" IS NOT NULL;
CREATE INDEX "notification_events_actor_id_idx" ON "notification_events" ("actor_id") WHERE "actor_id" IS NOT NULL;
