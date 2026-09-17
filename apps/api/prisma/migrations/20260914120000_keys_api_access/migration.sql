-- core/keys, фаза E: боты, ключи API, журнал обращений, политика ключей организации,
-- users.kind (person | bot). Дрейф индексов аналитики (rollup *_dims_key) сюда НЕ входит —
-- он живёт в отдельной истории партиций и в diff попадает всегда (см. analytics-миграции).
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'person';

-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "glyph" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "frozen_reason" TEXT,
    "frozen_at" TIMESTAMP(3),
    "rank" TEXT NOT NULL DEFAULT 'member',
    "responsible_user_id" TEXT,
    "purpose" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '{}',
    "ip_allowlist" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bot_id" TEXT,
    "user_id" TEXT,
    "workspace_id" TEXT,
    "family_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "hash_kid" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '{}',
    "ip_allowlist" JSONB NOT NULL DEFAULT '[]',
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "last_used_country" TEXT,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "revoked_note" TEXT,
    "rotated_from_id" TEXT,
    "grace_until" TIMESTAMP(3),
    "stored_hint" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_access_log" (
    "id" BIGSERIAL NOT NULL,
    "key_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "ip" TEXT,

    CONSTRAINT "api_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_key_policies" (
    "workspace_id" TEXT NOT NULL,
    "max_pat_days" INTEGER NOT NULL DEFAULT 90,
    "max_bot_key_days" INTEGER DEFAULT 365,
    "require_ip_allowlist" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_key_policies_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bots_user_id_key" ON "bots"("user_id");

-- CreateIndex
CREATE INDEX "bots_workspace_id_status_idx" ON "bots"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "bots_created_by_id_idx" ON "bots"("created_by_id");

-- CreateIndex
CREATE INDEX "bots_responsible_user_id_idx" ON "bots"("responsible_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- CreateIndex
CREATE INDEX "api_keys_family_id_idx" ON "api_keys"("family_id");

-- CreateIndex
CREATE INDEX "api_keys_bot_id_idx" ON "api_keys"("bot_id");

-- CreateIndex
CREATE INDEX "api_keys_user_id_workspace_id_idx" ON "api_keys"("user_id", "workspace_id");

-- CreateIndex
CREATE INDEX "api_keys_workspace_id_revoked_at_idx" ON "api_keys"("workspace_id", "revoked_at");

-- CreateIndex
CREATE INDEX "api_keys_expires_at_idx" ON "api_keys"("expires_at");

-- CreateIndex
CREATE INDEX "api_access_log_key_id_at_idx" ON "api_access_log"("key_id", "at");

-- CreateIndex
CREATE INDEX "api_access_log_at_idx" ON "api_access_log"("at");

-- CreateIndex
CREATE INDEX "users_kind_idx" ON "users"("kind");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_key_policies" ADD CONSTRAINT "workspace_key_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

