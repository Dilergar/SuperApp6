CREATE INDEX CONCURRENTLY IF NOT EXISTS chatter_entries_person_ids_idx ON chatter_entries USING gin (chatter_person_ids(payload, changes)) WHERE chatter_person_ids(payload, changes) <> '{}'::text[];
