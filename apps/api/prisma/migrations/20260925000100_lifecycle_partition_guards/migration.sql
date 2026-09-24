-- core/lifecycle: стражи сброса партиций.
--   1. Очередь без FK (`lifecycle_deleted_rows`): лист с необработанной строкой не сбрасывается
--      (`require_processed`) — проверяет функция владельца, а не код приложения.
--   2. Индексы под раннер purge (колонка срока ведёт индекс): хранилище заморозок, отметки
--      извлечения, прогоны, отчёты резервного копирования.
SET lock_timeout = '3s';

ALTER TABLE "lifecycle_partition_specs" ADD COLUMN "require_processed" BOOLEAN NOT NULL DEFAULT false;
UPDATE "lifecycle_partition_specs" SET "require_processed" = true WHERE "parent" = 'public.lifecycle_deleted_rows';

CREATE INDEX "lifecycle_hold_store_extracted_at_idx" ON "lifecycle_hold_store"("extracted_at");
CREATE INDEX "lifecycle_hold_extractions_extracted_at_idx" ON "lifecycle_hold_extractions"("extracted_at");
CREATE INDEX "lifecycle_runs_started_at_idx" ON "lifecycle_runs"("started_at");
CREATE INDEX "lifecycle_backup_runs_started_at_idx" ON "lifecycle_backup_runs"("started_at");

-- Сбросить лист: пол срока, архив и заморозки проверяются ЗДЕСЬ (базой), не в коде приложения.
-- Граница — из каталога (relpartbound), не из имени листа. DETACH внутри функции — обычный
-- (CONCURRENTLY из функции невозможен): короткая блокировка родителя под lock_timeout 2 с,
-- вызывающий повторяет с бэкоффом, при неудаче — пропуск и метрика. Оборванный когда-то
-- `DETACH … CONCURRENTLY` («detach pending») доводится FINALIZE — иначе сброс вставал бы навсегда.
CREATE OR REPLACE FUNCTION lifecycle_drop_partition(p_parent text, p_leaf text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  spec    lifecycle_partition_specs;
  sch     text := split_part(p_parent, '.', 1);
  tbl     text := split_part(p_parent, '.', 2);
  bound   text;
  hi_txt  text;
  hi      timestamptz;
  att     boolean;
  pending boolean;
  arch    lifecycle_partition_archives;
  blocker uuid;
  unprocessed boolean;
BEGIN
  SELECT * INTO spec FROM lifecycle_partition_specs WHERE parent = p_parent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is not a registered partitioned parent', p_parent;
  END IF;
  IF p_leaf !~ ('^' || tbl || '_[0-9]{4}_[0-9]{2}(_[0-9]{2})?$') THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is not a partition name of %', p_leaf, p_parent;
  END IF;
  IF to_regclass(format('%I.%I', sch, p_leaf)) IS NULL THEN
    RETURN false;
  END IF;
  SELECT pg_get_expr(c.relpartbound, c.oid), c.relispartition INTO bound, att
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = sch AND c.relname = p_leaf;
  IF att THEN
    SELECT i.inhdetachpending INTO pending FROM pg_inherits i
    WHERE i.inhrelid = format('%I.%I', sch, p_leaf)::regclass AND i.inhparent = format('%I.%I', sch, tbl)::regclass;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is not a partition of %', p_leaf, p_parent;
    END IF;
    hi_txt := substring(bound from 'TO \(''([^'']+)''\)');
    IF hi_txt IS NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: cannot read the bounds of %', p_leaf;
    END IF;
    -- timestamp без зоны — это UTC; timestamptz каталог печатает со смещением сессии
    hi := (hi_txt || CASE WHEN hi_txt ~ '[+-][0-9]{2}(:[0-9]{2})?$' THEN '' ELSE '+00' END)::timestamptz;
  ELSE
    -- Лист уже отсоединён (прерванный прошлый сброс): граница — из имени, дальше те же проверки
    SELECT b.hi INTO hi FROM lifecycle_partition_bounds(spec.period,
      (replace(substring(p_leaf from '_([0-9]{4}_[0-9]{2}(_[0-9]{2})?)$'), '_', '-') || CASE WHEN spec.period = 'month' THEN '-01' ELSE '' END || ' 00:00:00+00')::timestamptz) b;
  END IF;
  IF hi > now() - make_interval(days => spec.floor_days) THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is younger than the % day floor of %', p_leaf, spec.floor_days, p_parent;
  END IF;
  -- Очередь (учёт удалений без FK): необработанная строка держит сброс — иначе дети
  -- удалённого родителя остались бы сиротами навсегда
  IF spec.require_processed THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE processed_at IS NULL)', sch, p_leaf) INTO unprocessed;
    IF unprocessed THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % still has unprocessed rows', p_leaf;
    END IF;
  END IF;
  IF spec.require_archive THEN
    SELECT * INTO arch FROM lifecycle_partition_archives WHERE partition = sch || '.' || p_leaf;
    IF NOT FOUND OR arch.archived_at IS NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is not archived — refusing to drop', p_leaf;
    END IF;
  END IF;
  -- Заморозка: заморозка класса данных на всю платформу держит таблицу целиком; любая другая
  -- живая заморозка, способная задеть строки политики, требует отметки «строки извлечены»
  IF spec.hold_aware THEN
    SELECT h.id INTO blocker FROM lifecycle_holds h
    WHERE h.released_at IS NULL
      AND (
        (h.scope = 'class' AND h.data_class = spec.data_class AND h.workspace_id IS NULL)
        OR (
          ((h.scope = 'class' AND h.data_class = spec.data_class)
            OR h.scope IN ('custodian', 'space')
            OR (h.scope = 'record' AND h.record_type = spec.policy_id))
          AND NOT EXISTS (SELECT 1 FROM lifecycle_hold_extractions x WHERE x.hold_id = h.id AND x.partition = sch || '.' || p_leaf)
        )
      )
    LIMIT 1;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is under legal hold %', p_leaf, blocker;
    END IF;
  END IF;
  IF att THEN
    IF pending THEN
      EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I FINALIZE', sch, tbl, sch, p_leaf);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I', sch, tbl, sch, p_leaf);
    END IF;
  END IF;
  EXECUTE format('DROP TABLE %I.%I', sch, p_leaf);
  UPDATE lifecycle_partition_archives SET dropped_at = now() WHERE partition = sch || '.' || p_leaf;
  RETURN true;
END;
$$;
