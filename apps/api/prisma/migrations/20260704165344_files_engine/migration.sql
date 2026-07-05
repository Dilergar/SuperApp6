-- CreateTable
CREATE TABLE "file_objects" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "uploader_id" TEXT NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'generic',
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "public_token" TEXT,
    "scan_status" TEXT NOT NULL DEFAULT 'none',
    "storage_driver" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "upload_id" TEXT,
    "meta" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_links" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'attachment',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_variants" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_quota_usage" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "bytes_used" BIGINT NOT NULL DEFAULT 0,
    "files_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_quota_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_public_token_key" ON "file_objects"("public_token");

-- CreateIndex
CREATE INDEX "file_objects_owner_type_owner_id_status_idx" ON "file_objects"("owner_type", "owner_id", "status");

-- CreateIndex
CREATE INDEX "file_objects_status_created_at_idx" ON "file_objects"("status", "created_at");

-- CreateIndex
CREATE INDEX "file_objects_uploader_id_idx" ON "file_objects"("uploader_id");

-- CreateIndex
CREATE INDEX "file_links_ref_type_ref_id_idx" ON "file_links"("ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_links_file_id_ref_type_ref_id_role_key" ON "file_links"("file_id", "ref_type", "ref_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "file_variants_file_id_kind_key" ON "file_variants"("file_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "file_quota_usage_owner_type_owner_id_key" ON "file_quota_usage"("owner_type", "owner_id");

-- AddForeignKey
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
