-- ============================================================
-- core/keys (22-й движок) — keystore (обёрнутые корнем ключи) и журнал ключей
-- ============================================================
-- Корневой ключ ВНЕ БД (файл с правами / HSM): здесь только обёрнутый материал.
-- Дописано руками: журнал ключей append-only (триггеры immutable + no_truncate —
-- прецедент platform_audit_entries).

-- CreateTable
CREATE TABLE "crypto_keys" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "primary_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crypto_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crypto_key_versions" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "wrapped_material" BYTEA,
    "public_key" BYTEA,
    "root_kid" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "destroy_scheduled_at" TIMESTAMP(3),
    "destroyed_at" TIMESTAMP(3),

    CONSTRAINT "crypto_key_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_audit_entries" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_kind" TEXT NOT NULL DEFAULT 'user',
    "workspace_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "subject_name" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "details" JSONB,

    CONSTRAINT "key_audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crypto_keys_scope_purpose_name_key" ON "crypto_keys"("scope", "purpose", "name");

-- CreateIndex
CREATE INDEX "crypto_key_versions_key_id_state_idx" ON "crypto_key_versions"("key_id", "state");

-- CreateIndex
CREATE INDEX "crypto_key_versions_state_destroy_scheduled_at_idx" ON "crypto_key_versions"("state", "destroy_scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_key_versions_key_id_version_key" ON "crypto_key_versions"("key_id", "version");

-- CreateIndex
CREATE INDEX "key_audit_entries_workspace_id_id_idx" ON "key_audit_entries"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "key_audit_entries_subject_type_subject_id_id_idx" ON "key_audit_entries"("subject_type", "subject_id", "id");

-- CreateIndex
CREATE INDEX "key_audit_entries_actor_id_id_idx" ON "key_audit_entries"("actor_id", "id");

-- AddForeignKey
ALTER TABLE "crypto_key_versions" ADD CONSTRAINT "crypto_key_versions_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "crypto_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Журнал ключей — append-only: любой UPDATE/DELETE падает, TRUNCATE тоже.
CREATE OR REPLACE FUNCTION key_audit_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'key_audit_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "key_audit_entries_immutable"
  BEFORE UPDATE OR DELETE ON "key_audit_entries"
  FOR EACH ROW EXECUTE FUNCTION key_audit_entries_immutable();

CREATE OR REPLACE FUNCTION key_audit_entries_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'key_audit_entries is append-only (truncate is forbidden)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "key_audit_entries_no_truncate"
  BEFORE TRUNCATE ON "key_audit_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION key_audit_entries_no_truncate();

-- Версии ключа: состояние — только из словаря движка.
ALTER TABLE "crypto_key_versions" ADD CONSTRAINT "crypto_key_versions_state_check"
  CHECK ("state" IN ('pending', 'active', 'disabled', 'destroy_scheduled', 'destroyed'));
ALTER TABLE "crypto_keys" ADD CONSTRAINT "crypto_keys_purpose_check"
  CHECK ("purpose" IN ('kek', 'sign', 'mac'));
