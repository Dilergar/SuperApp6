-- ============================================================
-- core/visibility — перенос самодельных слоёв видимости в правила (этап Э2)
-- ============================================================
-- Источники: `users.card_visibility` (умолчание для Окружения), `circles.card_visibility`
-- (по Группам), `users.company_card_visibility` (коллегам), `users.online_status_mode`,
-- `workspaces.card_visibility` (анкета организации). После переноса колонки удаляются этой же
-- миграцией (прода ещё нет — окна совместимости не нужно).
--
-- Правило переноса личных полей (новая модель — объединение аудиторий + «скрыть от Группы»):
--   * человек настраивал карточку (есть умолчание или карта «в Компаниях») — поле НАСТРОЕНО:
--     умолчание «видно» → всё Окружение; «в Компаниях видно» → коллеги; Группа «видно» при
--     закрытом умолчании → эта Группа; Группа «скрыто» при открытом умолчании → скрыть от неё;
--     ничего — «Никто»;
--   * не настраивал — действуют НОВЫЕ умолчания платформы, Группы переносятся только разницей.
-- Реквизитные тумблеры (`extras`: ИИН, адрес, удостоверение, карта) не переносятся: кто их
-- видит, теперь решает организация (тип `staff.member`), а не человек.
--
-- Поля реестра, которые пишет эта миграция (страж `check:visibility` сверяет их с реестром):
-- visibility-field: birthDayMonth
-- visibility-field: birthYear
-- visibility-field: maritalStatus
-- visibility-field: city
-- visibility-field: bio
-- visibility-field: email
-- visibility-field: socialLinks
-- visibility-field: presence
-- visibility-field: description
-- visibility-field: industry
-- visibility-field: website
-- visibility-field: contactEmail
-- visibility-field: contactPhone
-- visibility-field: membersCount
-- visibility-field: requisites

-- Прежние флаги с прежними умолчаниями платформы (DEFAULT_CARD_VISIBILITY)
CREATE FUNCTION pg_temp.vis_old_flag(j JSONB, ofs TEXT[]) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  f TEXT;
  v BOOLEAN;
BEGIN
  FOREACH f IN ARRAY ofs LOOP
    v := NULL;
    IF j IS NOT NULL AND j ? f AND jsonb_typeof(j -> f) = 'boolean' THEN
      v := (j ->> f)::BOOLEAN;
    END IF;
    IF v IS NULL THEN
      v := f IN ('age', 'onlineStatus', 'city', 'bio', 'socialLinks');
    END IF;
    IF v THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

CREATE TEMP TABLE vis_mig_rows (
  owner_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  audience_kind TEXT NOT NULL,
  audience_id TEXT,
  effect TEXT NOT NULL
);

DO $$
DECLARE
  u RECORD;
  c RECORD;
  m RECORD;
  d BOOLEAN;
  co BOOLEAN;
  g BOOLEAN;
  configured BOOLEAN;
  granted BOOLEAN;
BEGIN
  FOR u IN
    SELECT id, card_visibility AS dv, company_card_visibility AS cv, online_status_mode AS om
    FROM users
    WHERE deleted_at IS NULL AND kind = 'person'
  LOOP
    configured := u.dv IS NOT NULL OR u.cv IS NOT NULL;
    FOR m IN
      SELECT * FROM (VALUES
        -- новое поле, прежние флаги, новые умолчания: Окружение / коллеги
        ('birthDayMonth', ARRAY['dateOfBirth'],        TRUE,  FALSE),
        ('birthYear',     ARRAY['dateOfBirth', 'age'], FALSE, FALSE),
        ('maritalStatus', ARRAY['maritalStatus'],      FALSE, FALSE),
        ('city',          ARRAY['city'],               TRUE,  TRUE),
        ('bio',           ARRAY['bio'],                TRUE,  TRUE),
        ('email',         ARRAY['email'],              FALSE, FALSE),
        ('socialLinks',   ARRAY['socialLinks'],        TRUE,  TRUE),
        ('presence',      ARRAY['onlineStatus'],       TRUE,  TRUE)
      ) AS t(nf, ofs, new_circle, new_colleagues)
    LOOP
      d := pg_temp.vis_old_flag(u.dv, m.ofs);
      co := pg_temp.vis_old_flag(u.cv, m.ofs);
      granted := FALSE;
      IF configured THEN
        IF d THEN
          INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'circle_all', NULL, 'allow');
          granted := TRUE;
        END IF;
        IF co THEN
          INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'colleagues', NULL, 'allow');
          granted := TRUE;
        END IF;
        FOR c IN SELECT id, card_visibility AS gv FROM circles WHERE owner_id = u.id AND card_visibility IS NOT NULL LOOP
          g := pg_temp.vis_old_flag(c.gv, m.ofs);
          IF g AND NOT d THEN
            INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'circle', c.id, 'allow');
            granted := TRUE;
          ELSIF NOT g AND d THEN
            INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'circle', c.id, 'deny');
          END IF;
        END LOOP;
        IF NOT granted THEN
          -- «Никто»: настроено, аудиторий нет
          INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'everybody', NULL, 'deny');
        END IF;
      ELSE
        FOR c IN SELECT id, card_visibility AS gv FROM circles WHERE owner_id = u.id AND card_visibility IS NOT NULL LOOP
          g := pg_temp.vis_old_flag(c.gv, m.ofs);
          IF g AND NOT m.new_circle THEN
            INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'circle', c.id, 'allow');
          ELSIF NOT g AND m.new_circle THEN
            INSERT INTO vis_mig_rows VALUES (u.id, m.nf, 'circle', c.id, 'deny');
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    -- «Онлайн-статус видят: Никто» — присутствие скрыто от всех
    IF u.om = 'nobody' THEN
      DELETE FROM vis_mig_rows WHERE owner_id = u.id AND field_key = 'presence';
      INSERT INTO vis_mig_rows VALUES (u.id, 'presence', 'everybody', NULL, 'deny');
    END IF;
  END LOOP;
END;
$$;

INSERT INTO "visibility_policies" ("id", "owner_type", "owner_id", "record_type", "version", "status", "published_at", "published_by_id", "created_by_id", "created_at", "updated_at")
SELECT gen_random_uuid()::TEXT, 'user', x.owner_id, 'user.card', 1, 'published', CURRENT_TIMESTAMP, x.owner_id, x.owner_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT owner_id FROM vis_mig_rows) x
ON CONFLICT DO NOTHING;

INSERT INTO "visibility_rules" ("id", "policy_id", "field_key", "audience_kind", "audience_id", "effect", "level", "reveal", "priority", "created_at")
SELECT gen_random_uuid()::TEXT, p.id, r.field_key, r.audience_kind, r.audience_id, r.effect,
       CASE WHEN r.effect = 'allow' THEN 'full' ELSE 'hidden' END, 'none', 0, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT owner_id, field_key, audience_kind, audience_id, effect FROM vis_mig_rows) r
JOIN "visibility_policies" p
  ON p.owner_type = 'user' AND p.owner_id = r.owner_id AND p.record_type = 'user.card' AND p.status = 'published';

DROP TABLE vis_mig_rows;

-- ---------- Анкета организации (workspace.card) ----------
-- Раньше владелец и админ видели всё, остальные члены — по флагам. Переносится только то, что
-- отличается от умолчаний реестра (они повторяют прежние умолчания): открытое по умолчанию и
-- выключенное — запрет Менеджеру/Сотруднику/Стажёру; закрытое по умолчанию и включённое —
-- разрешение им же.
CREATE TEMP TABLE vis_ws_rows (ws_id TEXT NOT NULL, field_key TEXT NOT NULL, role TEXT NOT NULL, effect TEXT NOT NULL);

INSERT INTO vis_ws_rows
SELECT w.id, f.field_key, r.role, CASE WHEN f.default_on THEN 'deny' ELSE 'allow' END
FROM workspaces w
CROSS JOIN (VALUES
  ('description', TRUE), ('industry', TRUE), ('city', TRUE), ('website', TRUE), ('contactEmail', TRUE),
  ('contactPhone', FALSE), ('membersCount', FALSE), ('requisites', TRUE)
) AS f(field_key, default_on)
CROSS JOIN (VALUES ('manager'), ('staff'), ('trainee')) AS r(role)
WHERE w.card_visibility IS NOT NULL
  AND w.card_visibility ? f.field_key
  AND jsonb_typeof(w.card_visibility -> f.field_key) = 'boolean'
  AND (w.card_visibility ->> f.field_key)::BOOLEAN <> f.default_on;

INSERT INTO "visibility_policies" ("id", "owner_type", "owner_id", "record_type", "version", "status", "published_at", "created_at", "updated_at")
SELECT gen_random_uuid()::TEXT, 'workspace', x.ws_id, 'workspace.card', 1, 'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT ws_id FROM vis_ws_rows) x
ON CONFLICT DO NOTHING;

INSERT INTO "visibility_rules" ("id", "policy_id", "field_key", "audience_kind", "audience_id", "effect", "level", "reveal", "priority", "created_at")
SELECT gen_random_uuid()::TEXT, p.id, r.field_key, 'role', r.role, r.effect,
       CASE WHEN r.effect = 'allow' THEN 'full' ELSE 'hidden' END, 'none', 0, CURRENT_TIMESTAMP
FROM vis_ws_rows r
JOIN "visibility_policies" p
  ON p.owner_type = 'workspace' AND p.owner_id = r.ws_id AND p.record_type = 'workspace.card' AND p.status = 'published';

DROP TABLE vis_ws_rows;

-- ---------- Самодельные слои уходят ----------
ALTER TABLE "users" DROP COLUMN "card_visibility";
ALTER TABLE "users" DROP COLUMN "company_card_visibility";
ALTER TABLE "users" DROP COLUMN "online_status_mode";
ALTER TABLE "circles" DROP COLUMN "card_visibility";
ALTER TABLE "workspaces" DROP COLUMN "card_visibility";
