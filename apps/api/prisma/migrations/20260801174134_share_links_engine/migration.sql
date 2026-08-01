-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "label" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "password_hash" TEXT,
    "max_opens" INTEGER,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_opened_at" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_link_visits" (
    "id" BIGSERIAL NOT NULL,
    "link_id" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "share_link_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");

-- CreateIndex
CREATE INDEX "share_links_ref_type_ref_id_idx" ON "share_links"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "share_links_created_by_id_idx" ON "share_links"("created_by_id");

-- CreateIndex
CREATE INDEX "share_links_owner_type_owner_id_idx" ON "share_links"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "share_link_visits_link_id_id_idx" ON "share_link_visits"("link_id", "id");

-- CreateIndex
CREATE INDEX "share_link_visits_opened_at_idx" ON "share_link_visits"("opened_at");

-- AddForeignKey
ALTER TABLE "share_link_visits" ADD CONSTRAINT "share_link_visits_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
