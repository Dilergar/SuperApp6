-- ============================================================
-- core/visibility (27-й движок) — правила видимости полей
-- ============================================================
-- Политика владельца (организация ИЛИ человек — Party-паттерн) версиями + правила строками +
-- настройки политики организации + ось находимости по номеру у человека.
--
-- Дописано руками (Prisma не выражает): частичные уникумы «одна опубликованная» и «один
-- черновик» на (владелец, тип), CHECK-и словарей и «цель правила — ровно одно из трёх».

-- ---------- Находимость по номеру (решение грилла №9) ----------
ALTER TABLE "users" ADD COLUMN "discoverable_by" TEXT NOT NULL DEFAULT 'everybody';
ALTER TABLE "users" ADD CONSTRAINT "users_discoverable_by_check"
  CHECK ("discoverable_by" IN ('everybody', 'circle', 'nobody'));

-- ---------- Политики ----------
CREATE TABLE "visibility_policies" (
    "id"              TEXT         NOT NULL,
    "owner_type"      TEXT         NOT NULL,
    "owner_id"        TEXT         NOT NULL,
    "record_type"     TEXT         NOT NULL,
    "version"         INTEGER      NOT NULL,
    "status"          TEXT         NOT NULL DEFAULT 'draft',
    "preset_key"      TEXT,
    "draft_token"     TEXT,
    "published_at"    TIMESTAMP(3),
    "published_by_id" TEXT,
    "created_by_id"   TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "visibility_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "visibility_policies_owner_type_check" CHECK ("owner_type" IN ('workspace', 'user')),
    CONSTRAINT "visibility_policies_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
    CONSTRAINT "visibility_policies_version_check" CHECK ("version" >= 1),
    -- Опубликованная версия несёт автора и момент; черновик — токен правки
    CONSTRAINT "visibility_policies_published_at_check" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "visibility_policies_owner_type_owner_id_record_type_version_key"
  ON "visibility_policies"("owner_type", "owner_id", "record_type", "version");
CREATE INDEX "visibility_policies_owner_type_owner_id_status_idx"
  ON "visibility_policies"("owner_type", "owner_id", "status");
-- Частичные уникумы: одна опубликованная и один черновик на (владелец, тип)
CREATE UNIQUE INDEX "visibility_policies_one_published"
  ON "visibility_policies"("owner_type", "owner_id", "record_type") WHERE "status" = 'published';
CREATE UNIQUE INDEX "visibility_policies_one_draft"
  ON "visibility_policies"("owner_type", "owner_id", "record_type") WHERE "status" = 'draft';

-- ---------- Правила ----------
CREATE TABLE "visibility_rules" (
    "id"            TEXT         NOT NULL,
    "policy_id"     TEXT         NOT NULL,
    "field_key"     TEXT,
    "group_key"     TEXT,
    "section_key"   TEXT,
    "audience_kind" TEXT         NOT NULL,
    "audience_id"   TEXT,
    "effect"        TEXT         NOT NULL,
    "level"         TEXT         NOT NULL,
    "mask"          TEXT,
    "reveal"        TEXT         NOT NULL DEFAULT 'none',
    "stage"         TEXT,
    "surfaces"      JSONB,
    "priority"      INTEGER      NOT NULL DEFAULT 0,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "visibility_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "visibility_rules_target_check" CHECK (num_nonnulls("field_key", "group_key", "section_key") = 1),
    CONSTRAINT "visibility_rules_effect_check" CHECK ("effect" IN ('allow', 'deny')),
    CONSTRAINT "visibility_rules_level_check" CHECK ("level" IN ('hidden', 'masked', 'full')),
    -- Запрет всегда скрывает: «deny full» был бы противоречием, которое кто-то однажды прочтёт как allow
    CONSTRAINT "visibility_rules_deny_hidden_check" CHECK ("effect" = 'allow' OR "level" = 'hidden'),
    CONSTRAINT "visibility_rules_reveal_check" CHECK ("reveal" IN ('none', 'one', 'delegated')),
    CONSTRAINT "visibility_rules_audience_kind_check" CHECK ("audience_kind" IN (
      'role', 'department', 'position', 'branch', 'manager_of', 'branch_head_of', 'branch_payroll',
      'everybody', 'circle_all', 'circle', 'colleagues', 'user'
    ))
);

CREATE INDEX "visibility_rules_policy_id_idx" ON "visibility_rules"("policy_id");
-- Уборка исключений по паре и правил удалённой Группы (R2) — по адресату
CREATE INDEX "visibility_rules_audience_kind_audience_id_idx" ON "visibility_rules"("audience_kind", "audience_id");

ALTER TABLE "visibility_rules" ADD CONSTRAINT "visibility_rules_policy_id_fkey"
  FOREIGN KEY ("policy_id") REFERENCES "visibility_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- Настройки политики организации (R18) ----------
CREATE TABLE "workspace_visibility_settings" (
    "workspace_id"     TEXT         NOT NULL,
    "notify_on_reveal" BOOLEAN      NOT NULL DEFAULT false,
    "dual_control"     BOOLEAN      NOT NULL DEFAULT false,
    "allow_delegation" BOOLEAN      NOT NULL DEFAULT false,
    "updated_by_id"    TEXT,
    "updated_at"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workspace_visibility_settings_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "workspace_visibility_settings" ADD CONSTRAINT "workspace_visibility_settings_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
