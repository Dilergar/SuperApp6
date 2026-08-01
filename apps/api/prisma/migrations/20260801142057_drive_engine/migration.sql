-- CreateTable
CREATE TABLE "drive_spaces" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "root_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_nodes" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "file_id" TEXT,
    "target_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "ancestor_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sort_rank" INTEGER NOT NULL DEFAULT 1,
    "trashed_at" TIMESTAMP(3),
    "trashed_root_id" TEXT,
    "subtree_bytes" BIGINT,
    "subtree_files" INTEGER,
    "system_key" TEXT,
    "taken_at_local" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_node_versions" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_id" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drive_node_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_stars" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drive_stars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_recents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drive_recents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_photo_buckets" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "drive_photo_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drive_spaces_owner_type_owner_id_kind_key" ON "drive_spaces"("owner_type", "owner_id", "kind");

-- CreateIndex
CREATE INDEX "drive_nodes_space_id_idx" ON "drive_nodes"("space_id");

-- CreateIndex
CREATE INDEX "drive_nodes_parent_id_idx" ON "drive_nodes"("parent_id");

-- CreateIndex
CREATE INDEX "drive_nodes_file_id_idx" ON "drive_nodes"("file_id");

-- CreateIndex
CREATE INDEX "drive_nodes_space_id_system_key_idx" ON "drive_nodes"("space_id", "system_key");

-- CreateIndex
CREATE INDEX "drive_node_versions_node_id_created_at_idx" ON "drive_node_versions"("node_id", "created_at");

-- CreateIndex
CREATE INDEX "drive_node_versions_file_id_idx" ON "drive_node_versions"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "drive_node_versions_node_id_version_no_key" ON "drive_node_versions"("node_id", "version_no");

-- CreateIndex
CREATE INDEX "drive_stars_user_id_created_at_idx" ON "drive_stars"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "drive_stars_node_id_idx" ON "drive_stars"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "drive_stars_user_id_node_id_key" ON "drive_stars"("user_id", "node_id");

-- CreateIndex
CREATE INDEX "drive_recents_user_id_opened_at_idx" ON "drive_recents"("user_id", "opened_at");

-- CreateIndex
CREATE INDEX "drive_recents_node_id_idx" ON "drive_recents"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "drive_recents_user_id_node_id_key" ON "drive_recents"("user_id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "drive_photo_buckets_space_id_month_key" ON "drive_photo_buckets"("space_id", "month");

-- CreateIndex
CREATE INDEX "file_objects_owner_type_owner_id_sha256_idx" ON "file_objects"("owner_type", "owner_id", "sha256");

-- AddForeignKey
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "drive_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_node_versions" ADD CONSTRAINT "drive_node_versions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_node_versions" ADD CONSTRAINT "drive_node_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_stars" ADD CONSTRAINT "drive_stars_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_recents" ADD CONSTRAINT "drive_recents_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_photo_buckets" ADD CONSTRAINT "drive_photo_buckets_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "drive_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================
-- РУЧНАЯ ЧАСТЬ: коллация, партиальные и GIN-индексы.
-- Prisma не выражает ни COLLATE, ни WHERE, ни USING GIN — пишем сами и зеркалим
-- комментами в schema.prisma (прецедент: jobs_engine, search, docs_engine).
-- ============================================

-- Естественный порядок имён: «файл2» перед «файл10» (ICU numeric ordering).
-- Детерминированная (по умолчанию) — иначе не годилась бы для unique и LIKE.
-- Локаль пишем в СТАНДАРТНОЙ форме: 'ru-RU-u-kn-true' Postgres нормализует сам и
-- печатает NOTICE на каждом прогоне миграции, включая теневую базу.
CREATE COLLATION "natural_ru" (provider = icu, locale = 'ru-RU-u-kn');

-- Коллация вешается НА КОЛОНКУ, а не пишется в ORDER BY: если коллация индекса и
-- запроса разойдутся, планировщик не сможет взять индекс и в плане навсегда поселится
-- узел Sort. Порядок важен — ALTER идёт ДО создания индекса по name.
ALTER TABLE "drive_nodes" ALTER COLUMN "name" TYPE TEXT COLLATE "natural_ru";

-- Листинг папки: keyset по (sort_rank, <ключ>, id). Направления в индексе объявлены
-- ТОЧНО так же, как в ORDER BY («папки вперёд» по возрастанию + свежие сверху), иначе
-- смешанные направления не дают взять индекс.
CREATE INDEX "drive_ls_name" ON "drive_nodes" ("parent_id", "sort_rank", "name", "id")
  WHERE "trashed_at" IS NULL;
CREATE INDEX "drive_ls_date" ON "drive_nodes" ("parent_id", "sort_rank", "updated_at" DESC, "id" DESC)
  WHERE "trashed_at" IS NULL;
CREATE INDEX "drive_ls_size" ON "drive_nodes" ("parent_id", "sort_rank", "subtree_bytes" DESC, "id" DESC)
  WHERE "trashed_at" IS NULL;

-- Одно имя в папке. Партиальный: удалённое в корзину имя освобождается сразу, иначе
-- нельзя было бы создать «Отчёт.pdf» рядом с «Отчёт.pdf», лежащим в корзине месяц.
CREATE UNIQUE INDEX "drive_name_uniq" ON "drive_nodes" ("parent_id", "name_key")
  WHERE "trashed_at" IS NULL;

-- Наследование прав и поддеревья: ancestor_ids && :granted / ancestor_ids @> ARRAY[:id]
CREATE INDEX "drive_anc" ON "drive_nodes" USING GIN ("ancestor_ids");

-- Корзина пространства и крон ретеншна
CREATE INDEX "drive_trash" ON "drive_nodes" ("space_id", "trashed_at")
  WHERE "trashed_at" IS NOT NULL;

-- «Грязные» папки роллапа (subtree_bytes = NULL — сентинел пересчёта)
CREATE INDEX "drive_dirty" ON "drive_nodes" ("space_id", "id")
  WHERE "kind" = 'folder' AND "subtree_bytes" IS NULL;

-- Лента «Фото»: обратный keyset по стенной дате съёмки
CREATE INDEX "drive_photo" ON "drive_nodes" ("space_id", "taken_at_local" DESC, "id")
  WHERE "kind" = 'file' AND "taken_at_local" IS NOT NULL AND "trashed_at" IS NULL;
