SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Снимки имён людей в JSON чужих записей (core/lifecycle, packages/shared/src/lifecycle/person-refs.ts):
-- имя лежит только парой с id того, чьё оно. Функции возвращают id людей строки — по ним
-- GIN-индекс находит записи хроники и уведомлений, где лежит имя стираемого человека, без
-- полного скана большой таблицы. Ключи = CHATTER_PERSON_ID_KEYS + CHANGE_PERSON_ID_KEYS /
-- NOTIFICATION_PERSON_ID_KEYS (смоук бута сверяет определение функции с константами).

CREATE OR REPLACE FUNCTION chatter_person_ids(payload jsonb, changes jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}'::text[]) FROM (
    SELECT payload->>'targetUserId' AS v
    UNION ALL SELECT payload->>'deputyUserId'
    UNION ALL SELECT c->>'fromUserId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(changes) = 'array' THEN changes ELSE '[]'::jsonb END) c
    UNION ALL SELECT c->>'toUserId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(changes) = 'array' THEN changes ELSE '[]'::jsonb END) c
  ) s
$$;

CREATE OR REPLACE FUNCTION notification_person_ids(payload jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}'::text[]) FROM (
    VALUES (payload->>'targetUserId'), (payload->>'otherUserId'), (payload->>'fromUserId'), (payload->>'byUserId'), (payload->>'ownerUserId')
  ) s(v)
$$;
