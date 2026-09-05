-- DropIndex
DROP INDEX "staff_branches_ancestor_ids_gin";

-- CreateTable
CREATE TABLE "note_spaces" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_folders" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "color" TEXT,
    "ancestor_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sort_rank" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "folder_id" TEXT,
    "folder_path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL DEFAULT '',
    "content" JSONB NOT NULL,
    "content_md" TEXT NOT NULL DEFAULT '',
    "plain_text" TEXT NOT NULL DEFAULT '',
    "content_hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "color" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pinned_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_revisions" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_links" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_board_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "folder_id" TEXT,
    "note_id" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "w" INTEGER NOT NULL DEFAULT 260,
    "h" INTEGER NOT NULL DEFAULT 220,
    "z" INTEGER NOT NULL DEFAULT 1,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_board_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_chunks" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "heading_path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text" TEXT NOT NULL,
    "context_prefix" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "note_spaces_owner_type_owner_id_key" ON "note_spaces"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "note_folders_space_id_parent_id_idx" ON "note_folders"("space_id", "parent_id");

-- CreateIndex
CREATE INDEX "note_folder_anc" ON "note_folders" USING GIN ("ancestor_ids" array_ops);

-- CreateIndex
CREATE INDEX "notes_space_id_folder_id_deleted_at_idx" ON "notes"("space_id", "folder_id", "deleted_at");

-- CreateIndex
CREATE INDEX "notes_space_id_updated_at_idx" ON "notes"("space_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "note_folder_path" ON "notes" USING GIN ("folder_path" array_ops);

-- CreateIndex
CREATE INDEX "note_tags" ON "notes" USING GIN ("tags" array_ops);

-- CreateIndex
CREATE UNIQUE INDEX "note_revisions_note_id_version_key" ON "note_revisions"("note_id", "version");

-- CreateIndex
CREATE INDEX "note_links_target_type_target_id_idx" ON "note_links"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "note_links_note_id_target_type_target_id_kind_key" ON "note_links"("note_id", "target_type", "target_id", "kind");

-- CreateIndex
CREATE INDEX "note_board_items_user_id_space_id_folder_id_idx" ON "note_board_items"("user_id", "space_id", "folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "note_board_items_user_id_note_id_key" ON "note_board_items"("user_id", "note_id");

-- CreateIndex
CREATE INDEX "note_chunks_space_id_idx" ON "note_chunks"("space_id");

-- CreateIndex
CREATE UNIQUE INDEX "note_chunks_note_id_ord_key" ON "note_chunks"("note_id", "ord");

-- AddForeignKey
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "note_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "note_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "note_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "note_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_board_items" ADD CONSTRAINT "note_board_items_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_board_items" ADD CONSTRAINT "note_board_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "note_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "note_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Дописано руками (Prisma не выражает WHERE и выражения) — зеркало в комментариях schema.prisma:
-- одно имя папки среди живых соседей (корень: parent_id IS NULL → '') и частичный индекс корзины.
-- ============================================================
CREATE UNIQUE INDEX "note_folder_name_uniq" ON "note_folders" ("space_id", COALESCE("parent_id", ''), "name_key") WHERE "deleted_at" IS NULL;
CREATE INDEX "note_trash" ON "notes" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
