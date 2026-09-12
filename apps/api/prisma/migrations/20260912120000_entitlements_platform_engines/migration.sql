-- ============================================================
-- core/entitlements (19-й движок) + core/platform (20-й движок)
-- ============================================================
-- Тариф и лимиты: планы версиями, подписки субъектов, гранты, оверрайды, счётчики
-- квот. Кабинет платформы: сотрудники и роли (ОТДЕЛЬНО от user_roles), сессии,
-- политика, append-only журнал команд, журнал чтений, заявки four-eyes.
--
-- Порядок несущий: сначала новые таблицы и сид каталога, затем ПЕРЕНОС данных
-- (subscriptions → subject_subscriptions, premium_until → грант, file_quota_usage →
-- quota_counters, user_roles platform_admin → platform_staff), и только потом дропы.
--
-- Партиальные уникумы и триггер неизменяемости журнала Prisma не выражает —
-- они дописаны руками ниже и продублированы комментарием в schema.prisma.

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_versions" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "region" TEXT NOT NULL DEFAULT 'KZ',
    "entitlements" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_subscriptions" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trial_ends_at" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "grace_until" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "trial_consumed_by" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_grants" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "reason" TEXT,
    "granted_by" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_overrides" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "value" JSONB,
    "reason" TEXT NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlement_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_counters" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_staff" (
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_staff_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "platform_staff_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{"kind":"global"}',
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "reason" TEXT NOT NULL,

    CONSTRAINT "platform_staff_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_policy" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "policy" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "platform_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_entries" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_roles_snapshot" JSONB NOT NULL DEFAULT '[]',
    "on_behalf_of_id" TEXT,
    "session_id" TEXT,
    "request_id" TEXT,
    "command_key" TEXT NOT NULL,
    "command_version" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB,
    "input_hash" TEXT,
    "target_type" TEXT,
    "target_id" TEXT,
    "target_workspace_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "outcome" TEXT NOT NULL,
    "error_code" TEXT,
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "risk" TEXT NOT NULL DEFAULT 'low',
    "reason" TEXT,
    "ticket_ref" TEXT,
    "approval_id" TEXT,
    "step_up_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "user_agent" TEXT,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_access_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "fields" JSONB,
    "request_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_command_requests" (
    "id" TEXT NOT NULL,
    "command_key" TEXT NOT NULL,
    "command_version" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB NOT NULL,
    "input_redacted" JSONB,
    "target_type" TEXT,
    "target_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT,
    "ticket_ref" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approval_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_comment" TEXT,
    "executed_audit_id" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_command_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "plan_versions_plan_id_status_idx" ON "plan_versions"("plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plan_versions_plan_id_version_key" ON "plan_versions"("plan_id", "version");

-- CreateIndex
CREATE INDEX "subject_subscriptions_subject_type_subject_id_status_idx" ON "subject_subscriptions"("subject_type", "subject_id", "status");

-- CreateIndex
CREATE INDEX "subject_subscriptions_status_trial_ends_at_idx" ON "subject_subscriptions"("status", "trial_ends_at");

-- CreateIndex
CREATE INDEX "subject_subscriptions_status_current_period_end_idx" ON "subject_subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "subject_subscriptions_status_grace_until_idx" ON "subject_subscriptions"("status", "grace_until");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_grants_idempotency_key_key" ON "entitlement_grants"("idempotency_key");

-- CreateIndex
CREATE INDEX "entitlement_grants_subject_type_subject_id_key_idx" ON "entitlement_grants"("subject_type", "subject_id", "key");

-- CreateIndex
CREATE INDEX "entitlement_grants_valid_until_idx" ON "entitlement_grants"("valid_until");

-- CreateIndex
CREATE INDEX "entitlement_overrides_valid_until_idx" ON "entitlement_overrides"("valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_overrides_subject_type_subject_id_key_key" ON "entitlement_overrides"("subject_type", "subject_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "quota_counters_subject_type_subject_id_key_key" ON "quota_counters"("subject_type", "subject_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "platform_staff_roles_user_id_role_key" ON "platform_staff_roles"("user_id", "role");

-- CreateIndex
CREATE INDEX "platform_sessions_user_id_idx" ON "platform_sessions"("user_id");

-- CreateIndex
CREATE INDEX "platform_sessions_expires_at_idx" ON "platform_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "platform_audit_entries_occurred_at_idx" ON "platform_audit_entries"("occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_entries_actor_id_occurred_at_idx" ON "platform_audit_entries"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_entries_target_type_target_id_occurred_at_idx" ON "platform_audit_entries"("target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_entries_command_key_occurred_at_idx" ON "platform_audit_entries"("command_key", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_access_log_actor_id_occurred_at_idx" ON "platform_access_log"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_access_log_target_type_target_id_occurred_at_idx" ON "platform_access_log"("target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_access_log_occurred_at_idx" ON "platform_access_log"("occurred_at");

-- CreateIndex
CREATE INDEX "platform_command_requests_status_created_at_idx" ON "platform_command_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "platform_command_requests_actor_id_created_at_idx" ON "platform_command_requests"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_command_requests_actor_id_command_key_idempotency__key" ON "platform_command_requests"("actor_id", "command_key", "idempotency_key");

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_subscriptions" ADD CONSTRAINT "subject_subscriptions_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_staff_roles" ADD CONSTRAINT "platform_staff_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_staff"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- Ручные ограничения (Prisma не выражает)
-- ============================================================

-- Одна ЖИВАЯ подписка на субъект (free = отсутствие живой строки).
CREATE UNIQUE INDEX "subject_subscriptions_live_uniq"
  ON "subject_subscriptions" ("subject_type", "subject_id")
  WHERE "status" IN ('trialing', 'active', 'past_due');

-- Один бизнес-триал на человека: колонка + частичный уникум вместо COUNT перед вставкой.
CREATE UNIQUE INDEX "subject_subscriptions_trial_consumer_uniq"
  ON "subject_subscriptions" ("trial_consumed_by")
  WHERE "subject_type" = 'workspace' AND "trial_consumed_by" IS NOT NULL;

-- Идемпотентность команд кабинета: ключ ОДНОГО сотрудника (S5); повтор с другим
-- входом ловится по input_hash в исполнителе.
CREATE UNIQUE INDEX "platform_audit_entries_idem_uniq"
  ON "platform_audit_entries" ("actor_id", "command_key", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Журнал команд — append-only: любой UPDATE/DELETE падает.
CREATE OR REPLACE FUNCTION platform_audit_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_audit_entries_immutable"
  BEFORE UPDATE OR DELETE ON "platform_audit_entries"
  FOR EACH ROW EXECUTE FUNCTION platform_audit_entries_immutable();

-- Политика кабинета — одна строка, four-eyes выключен по умолчанию.
INSERT INTO "platform_policy" ("id", "policy", "updated_at")
VALUES ('default', '{"dualControlEnabled": false}'::jsonb, (now() AT TIME ZONE 'UTC'));

-- ============================================================
-- Сид каталога: 7 ступеней, версия 1 у каждой.
-- Свободные ступени — опубликованный пустой JSON (все значения из defaultFree реестра).
-- Платные — ЧЕРНОВИКИ по политике-множителю (PLAN_SEED_POLICY в @superapp/shared):
-- personal = free ×2; бизнес: места 5/50/250, диск ×1/×5/×10, прочие ×1/×2/×4.
-- Черновик в продукт не попадает до публикации командой кабинета.
-- ============================================================

INSERT INTO "plans" ("id", "key", "subject_type", "status", "sort_order", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-000000000001', 'free',              'user',      'active', 0,  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000002', 'personal',          'user',      'active', 10, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000003', 'family',            'family',    'active', 20, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000004', 'business_free',     'workspace', 'active', 0,  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000005', 'business_basic',    'workspace', 'active', 10, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000006', 'business_standard', 'workspace', 'active', 20, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000007', 'business_pro',      'workspace', 'active', 30, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'));

INSERT INTO "plan_versions" ("id", "plan_id", "version", "status", "region", "entitlements", "note", "published_at", "published_by", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 1, 'published', 'KZ', '{}'::jsonb, 'free: defaultFree of the registry', (now() AT TIME ZONE 'UTC'), NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 1, 'draft', 'KZ',
    '{"workspaces.maxOwned": 40, "files.storageBytes": 32212254720, "contacts.maxCircles": 100, "shop.maxShowcases": 100, "skins.perGroup": true}'::jsonb,
    'seed: personal = free x2', NULL, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000003', 1, 'draft', 'KZ',
    '{"workspaces.maxOwned": 40, "files.storageBytes": 32212254720, "contacts.maxCircles": 100, "shop.maxShowcases": 100, "skins.perGroup": true}'::jsonb,
    'seed: family = free x2 (reserved)', NULL, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000004', 1, 'published', 'KZ', '{}'::jsonb, 'business_free: defaultFree of the registry', (now() AT TIME ZONE 'UTC'), NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000005', 1, 'draft', 'KZ',
    '{"workspace.seats": 5, "files.storageBytes": 107374182400, "shop.maxShowcases": 50, "objects.maxPerWorkspace": 2000, "legalEntities.maxPerWorkspace": 20, "notifications.smsPerDay": 500}'::jsonb,
    'seed: business_basic = seats 5, disk x1, others x1', NULL, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000006', 1, 'draft', 'KZ',
    '{"workspace.seats": 50, "files.storageBytes": 536870912000, "shop.maxShowcases": 100, "objects.maxPerWorkspace": 4000, "legalEntities.maxPerWorkspace": 40, "notifications.smsPerDay": 1000}'::jsonb,
    'seed: business_standard = seats 50, disk x5, others x2', NULL, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000007', 1, 'draft', 'KZ',
    '{"workspace.seats": 250, "files.storageBytes": 1073741824000, "shop.maxShowcases": 200, "objects.maxPerWorkspace": 8000, "legalEntities.maxPerWorkspace": 80, "notifications.smsPerDay": 2000}'::jsonb,
    'seed: business_pro = seats 250, disk x10, others x4', NULL, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'));

-- ============================================================
-- Перенос данных
-- ============================================================

-- Живые пользователи → 30 дней personal с момента миграции (решение продукта).
-- Пин на версию 1 плана: черновик резолвер не читает (значения free до публикации),
-- после публикации версии подписчики получают её значения без правок строк.
INSERT INTO "subject_subscriptions"
  ("id", "subject_type", "subject_id", "plan_version_id", "status", "started_at", "trial_ends_at", "source", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'user', u."id", '00000000-0000-4000-8000-000000000102', 'trialing',
  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '30 days', 'migration',
  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "users" u
WHERE u."deleted_at" IS NULL AND u."deletion_scheduled_at" IS NULL;

-- Самая старая живая организация каждого владельца → 30 дней business_pro, триал
-- владельца потрачен (частичный уникум не даст второго).
INSERT INTO "subject_subscriptions"
  ("id", "subject_type", "subject_id", "plan_version_id", "status", "started_at", "trial_ends_at", "source", "trial_consumed_by", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'workspace', w."id", '00000000-0000-4000-8000-000000000107', 'trialing',
  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '30 days', 'migration', w."owner_id",
  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM (
  SELECT DISTINCT ON (o."owner_id") o."id", o."owner_id"
  FROM "workspaces" o
  WHERE o."is_active" = true
  ORDER BY o."owner_id", o."created_at" ASC
) w;

-- Действующий премиум скинов → наследный грант `skins.perGroup` до прежнего срока.
INSERT INTO "entitlement_grants"
  ("id", "subject_type", "subject_id", "key", "value", "source", "priority", "effective_from", "valid_until", "reason", "granted_by", "idempotency_key", "created_at")
SELECT gen_random_uuid()::text, 'user', u."id", 'skins.perGroup', 'true'::jsonb, 'legacy', 0,
  (now() AT TIME ZONE 'UTC'), u."premium_until", 'migrated from users.premium_until', NULL,
  'legacy:premium:' || u."id", (now() AT TIME ZONE 'UTC')
FROM "users" u
WHERE u."premium_until" IS NOT NULL AND u."premium_until" > (now() AT TIME ZONE 'UTC');

-- Расход места и число файлов → счётчики квот (без периода).
INSERT INTO "quota_counters" ("id", "subject_type", "subject_id", "key", "used", "updated_at")
SELECT gen_random_uuid()::text, q."owner_type", q."owner_id", 'files.storageBytes', q."bytes_used", (now() AT TIME ZONE 'UTC')
FROM "file_quota_usage" q;

INSERT INTO "quota_counters" ("id", "subject_type", "subject_id", "key", "used", "updated_at")
SELECT gen_random_uuid()::text, q."owner_type", q."owner_id", 'files.count', q."files_count", (now() AT TIME ZONE 'UTC')
FROM "file_quota_usage" q;

-- Системная роль platform_admin → сотрудник платформы с ролью platform_owner;
-- прежняя строка user_roles гасится: у кабинета один источник правды.
INSERT INTO "platform_staff" ("user_id", "status", "note", "created_by", "created_at", "updated_at")
SELECT r."user_id", 'active', 'migrated from user_roles platform_admin', NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "user_roles" r
WHERE r."role" = 'platform_admin' AND r."context" = 'system' AND r."is_active" = true
ON CONFLICT ("user_id") DO NOTHING;

INSERT INTO "platform_staff_roles" ("id", "user_id", "role", "scope", "granted_by", "granted_at", "expires_at", "reason")
SELECT gen_random_uuid()::text, r."user_id", 'platform_owner', '{"kind":"global"}'::jsonb, r."user_id", (now() AT TIME ZONE 'UTC'), NULL,
  'migration: user_roles platform_admin'
FROM "user_roles" r
WHERE r."role" = 'platform_admin' AND r."context" = 'system' AND r."is_active" = true
ON CONFLICT ("user_id", "role") DO NOTHING;

UPDATE "user_roles" SET "is_active" = false
WHERE "role" = 'platform_admin' AND "context" = 'system' AND "is_active" = true;

INSERT INTO "platform_audit_entries"
  ("id", "occurred_at", "actor_id", "actor_roles_snapshot", "command_key", "command_version", "input", "target_type", "target_id", "outcome", "read_only", "risk", "reason", "dry_run", "duration_ms")
SELECT gen_random_uuid()::text, (now() AT TIME ZONE 'UTC'), NULL, '[]'::jsonb, 'platform.staff.migrate', 1,
  jsonb_build_object('userId', s."user_id"), 'user', s."user_id", 'ok', false, 'critical', 'migration: user_roles platform_admin -> platform_owner', false, 0
FROM "platform_staff" s;

-- ============================================================
-- Дропы старых носителей (данные перенесены выше)
-- ============================================================

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_user_id_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "premium_until";

-- DropTable
DROP TABLE "file_quota_usage";

-- DropTable
DROP TABLE "subscriptions";
