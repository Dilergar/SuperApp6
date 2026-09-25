CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_person_ids_idx ON messages USING gin (message_person_ids(payload)) WHERE type = 'system' AND message_person_ids(payload) <> '{}'::text[];
