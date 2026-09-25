-- core/lifecycle + core/audit — ревью: функции владельцев данных без подмены имён.
--
-- 1) SECURITY DEFINER-функции владельцев (`lifecycle_ensure_partition`, `lifecycle_drop_partition`,
--    `lifecycle_analyze_partitioned`, `audit_ensure_partition`, `audit_drop_partition`) исполнялись с
--    `search_path = public, pg_temp`. Схема public доступна на запись роли, которая ею владеет
--    (роль приложения, создавшая базу), а разрешение имён функций выбирает «лучшее совпадение
--    типов» среди ВСЕХ видимых схем: `public.format(text, text, text)` точнее, чем
--    `pg_catalog.format(text, VARIADIC "any")`, и исполнялась бы ОТ ВЛАДЕЛЬЦА данных — роль
--    приложения получала бы права sa6_data_owner / sa6_audit_owner (выключить триггер леджера,
--    сбросить журнал безопасности). Проверено на PG18: подмена срабатывает и при
--    `pg_catalog, public`. Теперь путь поиска — `pg_catalog, pg_temp`, все объекты public — с
--    явной схемой.
-- 2) `audit_ensure_partition`: лист журнала безопасности — CREATE (LIKE) + CHECK границ + ATTACH
--    (SHARE UPDATE EXCLUSIVE), а не `PARTITION OF` (ACCESS EXCLUSIVE на родителя: ожидание за
--    долгим чтением журнала выстраивало за собой КАЖДУЮ запись аудита — а она идёт в транзакции
--    каждого факта платформы); `lock_timeout 2 с` атрибутом, замок обслуживания родителя — как у
--    `lifecycle_ensure_partition` (plan §5.3: audit — та же машина состояний).
-- 3) Триггер учёта удалений `lifecycle_track_delete` — без блока EXCEPTION: каждый вход в него —
--    подтранзакция, и транзакция с десятками удалений из отслеживаемых таблиц переполняла кэш
--    подтранзакций (> 64 — SubtransSLRU на всех снимках). Лист дня заводится заранее по
--    `to_regclass`. Путь поиска без public: триггер срабатывает и под ролью миграций.
-- 4) Строковые стражи append-only, читающие родителя (`lifecycle_append_only_with_parent`), — с
--    явной схемой: временная таблица `fin_books` сессии (pg_temp ищется ПЕРВЫМ, если его нет в
--    пути) подменяла «жив ли родитель» и открывала DELETE истории при живой книге.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- ============================================================
-- 1. Функции-помощники партиций
-- ============================================================
CREATE OR REPLACE FUNCTION public.lifecycle_partition_bounds(p_period text, p_at timestamptz, OUT lo timestamptz, OUT hi timestamptz, OUT suffix text)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  base timestamp;
BEGIN
  IF p_period = 'month' THEN
    base := date_trunc('month', p_at AT TIME ZONE 'UTC');
    lo := base AT TIME ZONE 'UTC';
    hi := (base + interval '1 month') AT TIME ZONE 'UTC';
    suffix := to_char(base, 'YYYY_MM');
  ELSIF p_period = 'day' THEN
    base := date_trunc('day', p_at AT TIME ZONE 'UTC');
    lo := base AT TIME ZONE 'UTC';
    hi := (base + interval '1 day') AT TIME ZONE 'UTC';
    suffix := to_char(base, 'YYYY_MM_DD');
  ELSE
    RAISE EXCEPTION 'lifecycle_partition_bounds: unknown period %', p_period;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.lifecycle_partition_literal(p_parent regclass, p_column text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  typ regtype;
BEGIN
  SELECT a.atttypid::regtype INTO typ FROM pg_catalog.pg_attribute a WHERE a.attrelid = p_parent AND a.attname = p_column AND NOT a.attisdropped;
  IF typ IS NULL THEN
    RAISE EXCEPTION 'lifecycle_partition_literal: % has no column %', p_parent, p_column;
  END IF;
  IF typ = 'timestamp without time zone'::regtype THEN
    RETURN to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
  END IF;
  RETURN to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || '+00';
END;
$$;

-- ============================================================
-- 2. Функции владельца данных (SECURITY DEFINER)
-- ============================================================
-- Завести лист периода `p_at`: CREATE (LIKE родитель) + CHECK границ + ATTACH (SHARE UPDATE
-- EXCLUSIVE на родителя). Идемпотентна; DEFAULT-партиция запрещена; `lock_timeout 2 с` — атрибут.
CREATE OR REPLACE FUNCTION public.lifecycle_ensure_partition(p_parent text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  spec public.lifecycle_partition_specs;
  sch  text := split_part(p_parent, '.', 1);
  tbl  text := split_part(p_parent, '.', 2);
  leaf text;
  lo   timestamptz;
  hi   timestamptz;
  sfx  text;
  blo  text;
  bhi  text;
  c    text;
  t    text;
BEGIN
  SELECT * INTO spec FROM public.lifecycle_partition_specs WHERE parent = p_parent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_ensure_partition: % is not a registered partitioned parent', p_parent;
  END IF;
  SELECT b.lo, b.hi, b.suffix INTO lo, hi, sfx FROM public.lifecycle_partition_bounds(spec.period, p_at) b;
  leaf := tbl || '_' || sfx;
  IF to_regclass(format('%I.%I', sch, leaf)) IS NOT NULL THEN
    RETURN leaf;
  END IF;
  -- Одно обслуживание родителя за раз во всём флоте (транзакционный замок — живёт до конца вызова)
  PERFORM pg_advisory_xact_lock(hashtext('lifecycle:partition:' || p_parent));
  IF to_regclass(format('%I.%I', sch, leaf)) IS NOT NULL THEN
    RETURN leaf;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_partitioned_table pt WHERE pt.partrelid = format('%I.%I', sch, tbl)::regclass AND pt.partdefid <> 0) THEN
    RAISE EXCEPTION 'lifecycle_ensure_partition: % has a DEFAULT partition — forbidden (it is scanned on every attach)', p_parent;
  END IF;
  blo := public.lifecycle_partition_literal(format('%I.%I', sch, tbl)::regclass, spec.column_name, lo);
  bhi := public.lifecycle_partition_literal(format('%I.%I', sch, tbl)::regclass, spec.column_name, hi);
  EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING GENERATED)', sch, leaf, sch, tbl);
  EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I >= %L AND %I < %L)', sch, leaf, leaf || '_bounds', spec.column_name, blo, spec.column_name, bhi);
  EXECUTE format('ALTER TABLE %I.%I ATTACH PARTITION %I.%I FOR VALUES FROM (%L) TO (%L)', sch, tbl, sch, leaf, blo, bhi);
  EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', sch, leaf, leaf || '_bounds');
  IF spec.insert_scale IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I SET (autovacuum_vacuum_insert_scale_factor = %s, autovacuum_analyze_scale_factor = %s)', sch, leaf, spec.insert_scale, spec.insert_scale);
  END IF;
  FOREACH c IN ARRAY coalesce(spec.lz4_columns, ARRAY[]::text[]) LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET COMPRESSION lz4', sch, leaf, c);
  END LOOP;
  -- Строковые триггеры родителя клонируются в лист при ATTACH, но состояние ENABLE ALWAYS — нет
  FOREACH t IN ARRAY coalesce(spec.always_triggers, ARRAY[]::text[]) LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER %I', sch, leaf, t);
  END LOOP;
  -- Лист можно TRUNCATE напрямую, минуя родителя, — свой запрет на уровне оператора. Имя функции
  -- — идентификатором в схеме public (не текстом правила: правило — данные, не SQL)
  IF spec.no_truncate_function IS NOT NULL THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION public.%I()', tbl || '_no_truncate', sch, leaf, spec.no_truncate_function);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER %I', sch, leaf, tbl || '_no_truncate');
  END IF;
  RETURN leaf;
END;
$$;

-- Сбросить лист: пол срока, очередь, архив и заморозки проверяются ЗДЕСЬ (базой). Граница — из
-- каталога (relpartbound); оборванный `DETACH … CONCURRENTLY` доводится FINALIZE.
CREATE OR REPLACE FUNCTION public.lifecycle_drop_partition(p_parent text, p_leaf text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  spec    public.lifecycle_partition_specs;
  sch     text := split_part(p_parent, '.', 1);
  tbl     text := split_part(p_parent, '.', 2);
  bound   text;
  hi_txt  text;
  hi      timestamptz;
  att     boolean;
  pending boolean;
  arch    public.lifecycle_partition_archives;
  blocker uuid;
  unprocessed boolean;
BEGIN
  SELECT * INTO spec FROM public.lifecycle_partition_specs WHERE parent = p_parent;
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
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = sch AND c.relname = p_leaf;
  IF att THEN
    SELECT i.inhdetachpending INTO pending FROM pg_catalog.pg_inherits i
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
    SELECT b.hi INTO hi FROM public.lifecycle_partition_bounds(spec.period,
      (replace(substring(p_leaf from '_([0-9]{4}_[0-9]{2}(_[0-9]{2})?)$'), '_', '-') || CASE WHEN spec.period = 'month' THEN '-01' ELSE '' END || ' 00:00:00+00')::timestamptz) b;
  END IF;
  IF hi > now() - make_interval(days => spec.floor_days) THEN
    RAISE EXCEPTION 'lifecycle_drop_partition: % is younger than the % day floor of %', p_leaf, spec.floor_days, p_parent;
  END IF;
  -- Очередь (учёт удалений без FK): необработанная строка держит сброс
  IF spec.require_processed THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE processed_at IS NULL)', sch, p_leaf) INTO unprocessed;
    IF unprocessed THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % still has unprocessed rows', p_leaf;
    END IF;
  END IF;
  IF spec.require_archive THEN
    SELECT * INTO arch FROM public.lifecycle_partition_archives WHERE partition = sch || '.' || p_leaf;
    IF NOT FOUND OR arch.archived_at IS NULL THEN
      RAISE EXCEPTION 'lifecycle_drop_partition: % is not archived — refusing to drop', p_leaf;
    END IF;
  END IF;
  -- Заморозка класса данных на всю платформу держит таблицу целиком; любая другая живая
  -- заморозка, способная задеть строки политики, требует отметки «строки извлечены»
  IF spec.hold_aware THEN
    SELECT h.id INTO blocker FROM public.lifecycle_holds h
    WHERE h.released_at IS NULL
      AND (
        (h.scope = 'class' AND h.data_class = spec.data_class AND h.workspace_id IS NULL)
        OR (
          ((h.scope = 'class' AND h.data_class = spec.data_class)
            OR h.scope IN ('custodian', 'space')
            OR (h.scope = 'record' AND h.record_type = spec.policy_id))
          AND NOT EXISTS (SELECT 1 FROM public.lifecycle_hold_extractions x WHERE x.hold_id = h.id AND x.partition = sch || '.' || p_leaf)
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
  UPDATE public.lifecycle_partition_archives SET dropped_at = now() WHERE partition = sch || '.' || p_leaf;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.lifecycle_analyze_partitioned(p_parent text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lifecycle_partition_specs WHERE parent = p_parent) THEN
    RAISE EXCEPTION 'lifecycle_analyze_partitioned: % is not a registered partitioned parent', p_parent;
  END IF;
  EXECUTE format('ANALYZE %I.%I', split_part(p_parent, '.', 1), split_part(p_parent, '.', 2));
END;
$$;

-- Месяц журнала безопасности: та же машина, что у `lifecycle_ensure_partition` — CHECK границ +
-- ATTACH вместо PARTITION OF, `lock_timeout 2 с`, один обслуживающий родителя за раз. Чужая
-- таблица с именем будущей партиции — громкий отказ (вставки месяца иначе падали бы молча).
CREATE OR REPLACE FUNCTION public.audit_ensure_partition(p_month date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  lo   timestamp := date_trunc('month', p_month)::timestamp;
  hi   timestamp := date_trunc('month', p_month)::timestamp + interval '1 month';
  name text := 'security_events_' || to_char(date_trunc('month', p_month), 'YYYY_MM');
  rel  regclass;
BEGIN
  rel := to_regclass('public.' || name);
  IF rel IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('lifecycle:partition:public.security_events'));
    rel := to_regclass('public.' || name);
  END IF;
  IF rel IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I (LIKE public.security_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING GENERATED)', name);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ("occurred_at" >= %L AND "occurred_at" < %L)', name, name || '_bounds', lo, hi);
    EXECUTE format('ALTER TABLE public.security_events ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)', name, lo, hi);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', name, name || '_bounds');
    EXECUTE format('ALTER TABLE public.%I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', name);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN "details" SET COMPRESSION lz4', name);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN "evidence" SET COMPRESSION lz4', name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER "security_events_guard"', name);
    EXECUTE format('CREATE TRIGGER "security_events_no_truncate" BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.security_events_no_truncate()', name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER "security_events_no_truncate"', name);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid = rel AND inhparent = 'public.security_events'::regclass) THEN
    RAISE EXCEPTION 'audit_ensure_partition: % exists but is not a partition of security_events', name;
  END IF;
  RETURN name;
END;
$$;

-- Сброс выгруженного месяца: пол «3 года» и границы — из ИМЕНИ, строка архива обязана описывать
-- ровно этот месяц; DETACH под `lock_timeout 2 с` (вызывающий повторяет с бэкоффом).
CREATE OR REPLACE FUNCTION public.audit_drop_partition(p_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  arch record;
  lo   timestamp;
  hi   timestamp;
BEGIN
  IF p_name !~ '^security_events_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'audit_drop_partition: not a security_events partition: %', p_name;
  END IF;
  lo := to_date(substr(p_name, 17), 'YYYY_MM')::timestamp;
  hi := lo + interval '1 month';
  SELECT * INTO arch FROM public.security_partition_archives WHERE "partition" = p_name;
  IF NOT FOUND OR arch."archived_at" IS NULL THEN
    RAISE EXCEPTION 'audit_drop_partition: % is not archived — refusing to drop', p_name;
  END IF;
  IF arch."from_at" <> lo OR arch."to_at" <> hi THEN
    RAISE EXCEPTION 'audit_drop_partition: the archive record of % does not describe its month — refusing to drop', p_name;
  END IF;
  IF hi > (now() AT TIME ZONE 'UTC') - interval '3 years' THEN
    RAISE EXCEPTION 'audit_drop_partition: % is younger than the 3-year retention floor', p_name;
  END IF;
  IF to_regclass('public.' || p_name) IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('ALTER TABLE public.security_events DETACH PARTITION public.%I', p_name);
  EXECUTE format('DROP TABLE public.%I', p_name);
  UPDATE public.security_partition_archives SET "dropped_at" = (now() AT TIME ZONE 'UTC') WHERE "partition" = p_name;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.lifecycle_ensure_partition(text, timestamptz), public.lifecycle_drop_partition(text, text), public.lifecycle_analyze_partitioned(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_ensure_partition(date), public.audit_drop_partition(text) FROM PUBLIC;

-- ============================================================
-- 3. Учёт удалений без подтранзакции
-- ============================================================
CREATE OR REPLACE FUNCTION public.lifecycle_track_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ws_col text := COALESCE(TG_ARGV[0], '');
BEGIN
  -- Строка учёта ложится в лист дня транзакции (deleted_at = now()); нет листа (крон не дошёл) —
  -- заводит функция владельца. Проверка по каталогу вместо EXCEPTION: без подтранзакции
  IF to_regclass('public.lifecycle_deleted_rows_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM_DD')) IS NULL THEN
    PERFORM public.lifecycle_ensure_partition('public.lifecycle_deleted_rows', now());
  END IF;
  IF ws_col = '' THEN
    INSERT INTO public.lifecycle_deleted_rows (table_name, row_id) SELECT TG_TABLE_NAME, o.id FROM old_rows o;
  ELSE
    EXECUTE format('INSERT INTO public.lifecycle_deleted_rows (table_name, row_id, workspace_id) SELECT %L, o.id, o.%I FROM old_rows o', TG_TABLE_NAME, ws_col);
  END IF;
  RETURN NULL;
END
$$;

-- ============================================================
-- 4. Стражи append-only — явная схема и путь поиска без public/pg_temp
-- ============================================================
CREATE OR REPLACE FUNCTION public.lifecycle_append_only_with_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  alive boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only (update is forbidden)', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'card_skin_transfers' THEN
    SELECT EXISTS (SELECT 1 FROM public.card_skin_instances WHERE "id" = OLD."instance_id") INTO alive;
  ELSIF TG_TABLE_NAME = 'fin_audit_logs' THEN
    SELECT EXISTS (SELECT 1 FROM public.fin_books WHERE "id" = OLD."book_id") INTO alive;
  ELSE
    RAISE EXCEPTION 'lifecycle_append_only_with_parent: unexpected table %', TG_TABLE_NAME;
  END IF;
  IF alive THEN
    RAISE EXCEPTION '% is append-only while its parent lives (delete is forbidden)', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$;

-- Стражи без ссылок на таблицы — только путь поиска (тело не меняется)
ALTER FUNCTION public.lifecycle_holds_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.lifecycle_erasure_journal_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.lifecycle_no_truncate() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.lifecycle_append_only() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.lifecycle_escrow_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.security_events_guard() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.security_events_no_truncate() SET search_path = pg_catalog, pg_temp;
