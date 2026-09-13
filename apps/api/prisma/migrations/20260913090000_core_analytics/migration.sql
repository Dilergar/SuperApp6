-- ============================================================
-- core/analytics (21-й движок) — продуктовая аналитика
-- ============================================================
-- Раскладка несущая: СЫРЬЁ — в схеме `analytics` (партиции по месяцу создаёт крон
-- `AnalyticsCron.ensurePartitions`), Prisma сравнивает только `public` и партиций не
-- видит. В `public` — склейка личности, рубильник, карантин, роллапы, отчёты, дашборды
-- и тумблер отказа человека. Время сырья — `timestamptz` (день считается в APP_TIMEZONE).
--
-- Дописано руками (Prisma не выражает): схема `analytics` целиком, уникумы роллапов
-- `NULLS NOT DISTINCT` (измерения workspace_id/plan_key бывают NULL).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "analytics_opt_out" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "analytics_identity_links" (
    "anonymous_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contested" BOOLEAN NOT NULL DEFAULT false,
    "contested_at" TIMESTAMP(3),
    "source" TEXT NOT NULL,

    CONSTRAINT "analytics_identity_links_pkey" PRIMARY KEY ("anonymous_id")
);

-- CreateTable
CREATE TABLE "analytics_event_overrides" (
    "event_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "set_by" TEXT,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_event_overrides_pkey" PRIMARY KEY ("event_key")
);

-- CreateTable
CREATE TABLE "analytics_quarantine" (
    "id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sample_shape" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "analytics_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_rollup_event_day" (
    "id" BIGSERIAL NOT NULL,
    "day" DATE NOT NULL,
    "workspace_id" UUID,
    "service" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "plan_key" TEXT,
    "count" INTEGER NOT NULL,
    "users" INTEGER NOT NULL,
    "workspaces" INTEGER NOT NULL,

    CONSTRAINT "analytics_rollup_event_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_rollup_actor_day" (
    "id" BIGSERIAL NOT NULL,
    "day" DATE NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_kind" SMALLINT NOT NULL DEFAULT 0,
    "workspace_id" UUID,
    "service" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "plan_key" TEXT,
    "events" INTEGER NOT NULL,
    "qualifying" BOOLEAN NOT NULL,

    CONSTRAINT "analytics_rollup_actor_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_rollup_session_day" (
    "id" BIGSERIAL NOT NULL,
    "day" DATE NOT NULL,
    "workspace_id" UUID,
    "platform" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL,
    "duration_p50_s" INTEGER NOT NULL,
    "events_per_session" REAL NOT NULL,

    CONSTRAINT "analytics_rollup_session_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_reports" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "system_key" TEXT,
    "query" JSONB NOT NULL,
    "viz" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'shared',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_dashboards" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "system_key" TEXT,
    "tiles" JSONB NOT NULL DEFAULT '[]',
    "visibility" TEXT NOT NULL DEFAULT 'shared',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_identity_links_user_id_idx" ON "analytics_identity_links"("user_id");

-- CreateIndex
CREATE INDEX "analytics_quarantine_last_seen_at_idx" ON "analytics_quarantine"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_quarantine_event_key_reason_key" ON "analytics_quarantine"("event_key", "reason");

-- CreateIndex
CREATE INDEX "analytics_rollup_event_day_day_idx" ON "analytics_rollup_event_day"("day");

-- CreateIndex
CREATE INDEX "analytics_rollup_event_day_event_key_day_idx" ON "analytics_rollup_event_day"("event_key", "day");

-- CreateIndex
CREATE INDEX "analytics_rollup_event_day_workspace_id_day_idx" ON "analytics_rollup_event_day"("workspace_id", "day");

-- CreateIndex
CREATE INDEX "analytics_rollup_actor_day_day_idx" ON "analytics_rollup_actor_day"("day");

-- CreateIndex
CREATE INDEX "analytics_rollup_actor_day_actor_id_day_idx" ON "analytics_rollup_actor_day"("actor_id", "day");

-- CreateIndex
CREATE INDEX "analytics_rollup_actor_day_workspace_id_day_idx" ON "analytics_rollup_actor_day"("workspace_id", "day");

-- CreateIndex
CREATE INDEX "analytics_rollup_session_day_day_idx" ON "analytics_rollup_session_day"("day");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_reports_system_key_key" ON "analytics_reports"("system_key");

-- CreateIndex
CREATE INDEX "analytics_reports_visibility_updated_at_idx" ON "analytics_reports"("visibility", "updated_at");

-- CreateIndex
CREATE INDEX "analytics_reports_created_by_idx" ON "analytics_reports"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_dashboards_system_key_key" ON "analytics_dashboards"("system_key");

-- CreateIndex
CREATE INDEX "analytics_dashboards_visibility_updated_at_idx" ON "analytics_dashboards"("visibility", "updated_at");


-- ------------------------------------------------------------
-- Уникумы роллапов с NULL-измерениями (руками)
-- ------------------------------------------------------------
CREATE UNIQUE INDEX "analytics_rollup_event_day_dims_key" ON "analytics_rollup_event_day"
  ("day", "workspace_id", "service", "event_key", "platform", "plan_key") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "analytics_rollup_actor_day_dims_key" ON "analytics_rollup_actor_day"
  ("day", "actor_id", "workspace_id", "service", "platform", "plan_key") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "analytics_rollup_session_day_dims_key" ON "analytics_rollup_session_day"
  ("day", "workspace_id", "platform") NULLS NOT DISTINCT;

-- ------------------------------------------------------------
-- Схема сырья (руками)
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS analytics;

-- Событие. ts = occurred_at, клампнутое в [received_at − 7 д, received_at + 1 ч]
-- (time_corrected = true, если клампнули). Коды smallint — ANALYTICS_*_CODE в shared.
-- IP и сырой User-Agent НЕ хранятся; тариф — СНИМОК в момент события.
CREATE TABLE analytics.events (
  event_id        uuid         NOT NULL,
  ts              timestamptz  NOT NULL,
  occurred_at     timestamptz  NOT NULL,
  received_at     timestamptz  NOT NULL,
  time_corrected  boolean      NOT NULL DEFAULT false,
  event_key       text         NOT NULL,
  service         text         NOT NULL,
  class           smallint     NOT NULL,
  source          smallint     NOT NULL,
  user_id         uuid,
  anonymous_id    uuid,
  workspace_id    uuid,
  owner_type      smallint     NOT NULL,
  session_id      uuid,
  device_id       uuid,
  login_sid       uuid,
  plan_key        text,
  plan_version    integer,
  role            text,
  platform        text         NOT NULL,
  app_version     text,
  device_class    smallint,
  os              text,
  browser         text,
  locale          text,
  tz              text,
  country         char(2),
  route           text,
  ref_type        text,
  ref_id          uuid,
  props           jsonb        NOT NULL DEFAULT '{}'::jsonb,
  sample_rate     real         NOT NULL DEFAULT 1,
  is_internal     boolean      NOT NULL DEFAULT false,
  schema_version  smallint     NOT NULL DEFAULT 1,
  ingest_version  smallint     NOT NULL DEFAULT 1
) PARTITION BY RANGE (ts);

-- Индексы родителя наследуются каждой партицией (и созданными кроном)
CREATE UNIQUE INDEX events_event_id_ts_key ON analytics.events (event_id, ts);
CREATE INDEX events_ts_brin ON analytics.events USING brin (ts);
CREATE INDEX events_event_key_ts_idx ON analytics.events (event_key, ts);
CREATE INDEX events_user_id_ts_idx ON analytics.events (user_id, ts) WHERE user_id IS NOT NULL;
CREATE INDEX events_workspace_id_ts_idx ON analytics.events (workspace_id, ts) WHERE workspace_id IS NOT NULL;
CREATE INDEX events_anonymous_id_idx ON analytics.events (anonymous_id) WHERE anonymous_id IS NOT NULL;

-- Партиции: текущий месяц + два следующих (UTC-границы месяцев); дальше — крон.
DO $$
DECLARE
  m date := date_trunc('month', (now() AT TIME ZONE 'UTC'))::date;
  i int;
  lo date;
  hi date;
BEGIN
  FOR i IN 0..2 LOOP
    lo := (m + make_interval(months => i))::date;
    hi := (m + make_interval(months => i + 1))::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS analytics.%I PARTITION OF analytics.events FOR VALUES FROM (%L) TO (%L)',
      'events_' || to_char(lo, 'YYYY_MM'),
      (lo::timestamp AT TIME ZONE 'UTC'),
      (hi::timestamp AT TIME ZONE 'UTC')
    );
    -- Таблица только растёт вставками: автовакуум (карта видимости, статистика)
    -- должен приходить по объёму вставок, а не по дефолтным 20 % строк
    EXECUTE format('ALTER TABLE analytics.%I SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', 'events_' || to_char(lo, 'YYYY_MM'));
  END LOOP;
END $$;

-- Очередь серверных событий: строка пишется В ТРАНЗАКЦИИ доменной мутации (откат =
-- события нет), дренаж — консьюмер `DELETE … FOR UPDATE SKIP LOCKED … RETURNING`.
CREATE TABLE analytics.outbox (
  id          bigserial    PRIMARY KEY,
  payload     jsonb        NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
