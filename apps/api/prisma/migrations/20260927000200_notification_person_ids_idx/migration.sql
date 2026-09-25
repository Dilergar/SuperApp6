CREATE INDEX CONCURRENTLY IF NOT EXISTS notification_events_person_ids_idx ON notification_events USING gin (notification_person_ids(payload)) WHERE notification_person_ids(payload) <> '{}'::text[];
