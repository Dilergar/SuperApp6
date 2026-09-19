-- core/consents: лестница статуса версии — на уровне базы.
-- Подпись платформы покрывает текст, манифест и дату вступления, но НЕ статус: прежний триггер
-- пропускал `withdrawn → published` и `superseded → published`. Одной правкой статуса отозванный
-- (никогда не действовавший) или заменённый текст становился действующим — с целой подписью.
-- Обратное тоже опасно: `withdrawn` у уже вступившей существенной версии уменьшает глобальную
-- эпоху шлюза, и следующая версия вернула бы её к значению, которое люди уже «догнали» —
-- быстрый путь шлюза пропускал бы их без приёмки. Теперь статус ходит только вперёд.
CREATE OR REPLACE FUNCTION consent_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'consent_versions: a published version cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'draft' THEN
    RAISE EXCEPTION 'consent_versions: a published version cannot return to draft';
  END IF;
  -- Лестница статуса — только вперёд: published → superseded | withdrawn; оба конечны.
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'published' OR NEW."status" NOT IN ('superseded', 'withdrawn') THEN
      RAISE EXCEPTION 'consent_versions: status may only move published -> superseded | withdrawn';
    END IF;
    -- Отозвать можно только НЕ вступившую версию (минута — допуск на расхождение часов API и базы)
    IF NEW."status" = 'withdrawn' AND OLD."effective_from" <= (now() AT TIME ZONE 'UTC') - interval '1 minute' THEN
      RAISE EXCEPTION 'consent_versions: a version already in force cannot be withdrawn';
    END IF;
  END IF;
  IF NEW."document_key" IS DISTINCT FROM OLD."document_key"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."bodies" IS DISTINCT FROM OLD."bodies"
     OR NEW."summaries" IS DISTINCT FROM OLD."summaries"
     OR NEW."change_summary" IS DISTINCT FROM OLD."change_summary"
     OR NEW."hashes" IS DISTINCT FROM OLD."hashes"
     OR NEW."manifest_hash" IS DISTINCT FROM OLD."manifest_hash"
     OR NEW."prev_manifest_hash" IS DISTINCT FROM OLD."prev_manifest_hash"
     OR NEW."material" IS DISTINCT FROM OLD."material"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."urgent_reason" IS DISTINCT FROM OLD."urgent_reason"
     OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
     OR NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
  THEN
    RAISE EXCEPTION 'consent_versions: a published version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
