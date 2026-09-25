SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Имена людей в системных плашках чатов (packages/shared/src/lifecycle/person-refs.ts): актор
-- структуры записи (`chatter.actorName` ↔ `chatter.actorId`), пары в её payload и изменениях,
-- пары в payload события уведомления. Функция возвращает id людей плашки — по ним частичный
-- GIN-индекс (следующая миграция) находит плашки с именем стираемого человека без скана
-- переписки. Ключи = MESSAGE_PERSON_ID_KEYS (смоук бута сверяет определение с константой).

CREATE OR REPLACE FUNCTION message_person_ids(payload jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}'::text[]) FROM (
    SELECT payload->'chatter'->>'actorId' AS v
    UNION ALL SELECT payload->'chatter'->'payload'->>'targetUserId'
    UNION ALL SELECT payload->'chatter'->'payload'->>'deputyUserId'
    UNION ALL SELECT c->>'fromUserId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'chatter'->'changes') = 'array' THEN payload->'chatter'->'changes' ELSE '[]'::jsonb END) c
    UNION ALL SELECT c->>'toUserId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'chatter'->'changes') = 'array' THEN payload->'chatter'->'changes' ELSE '[]'::jsonb END) c
    UNION ALL SELECT payload->'notification'->'payload'->>'targetUserId'
    UNION ALL SELECT payload->'notification'->'payload'->>'otherUserId'
    UNION ALL SELECT payload->'notification'->'payload'->>'fromUserId'
    UNION ALL SELECT payload->'notification'->'payload'->>'byUserId'
    UNION ALL SELECT payload->'notification'->'payload'->>'ownerUserId'
  ) s
$$;

-- Плашки участников группы: имя цели — `targetName` (пара `targetUserId`, PERSON_NAME_REFS).
-- Старые несли `name` без id: ключ переименовывается, чтобы рендер читал один ключ
UPDATE messages
   SET payload = jsonb_set(payload #- '{chatter,payload,name}', '{chatter,payload,targetName}', payload->'chatter'->'payload'->'name')
 WHERE type = 'system'
   AND payload->>'eventType' IN ('group.member_added', 'group.member_removed', 'group.admin_granted')
   AND payload->'chatter'->'payload' ? 'name'
   AND NOT (payload->'chatter'->'payload' ? 'targetName');
