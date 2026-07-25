-- ============================================
-- DOCS ENGINE (core/docs) — 12-й платформенный движок: работа с документами.
-- Документ = живой файл core/files (мутируется на месте) + неизменяемые вехи-версии.
-- FK на file_objects нет намеренно: физическая уборка файла не имеет права каскадом
-- стереть журнал версий (паттерн FileLink/CallSession — полиморфные ссылки без FK).
-- ============================================

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "editor_kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'edit',
    "status" TEXT NOT NULL DEFAULT 'active',
    "editor_base_url" TEXT,
    "token_epoch" INTEGER NOT NULL DEFAULT 1,
    "last_version_no" INTEGER NOT NULL DEFAULT 0,
    "last_saved_at" TIMESTAMP(3),
    "last_editor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "file_id" TEXT,
    "sha256" TEXT,
    "size" BIGINT,
    "reason" TEXT NOT NULL,
    "created_by_id" TEXT,
    "author_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sessions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "lock_value" TEXT NOT NULL,
    "editor_base_url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_put_at" TIMESTAMP(3),
    "exit_save_seen" BOOLEAN NOT NULL DEFAULT false,
    "participant_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "document_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_file_id_key" ON "documents"("file_id");

-- CreateIndex
CREATE INDEX "documents_owner_type_owner_id_status_idx" ON "documents"("owner_type", "owner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "document_versions_document_id_created_at_idx" ON "document_versions"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "document_versions_status_created_at_idx" ON "document_versions"("status", "created_at");

-- CreateIndex
CREATE INDEX "document_sessions_document_id_idx" ON "document_sessions"("document_id");

-- CreateIndex
CREATE INDEX "document_sessions_status_expires_at_idx" ON "document_sessions"("status", "expires_at");

-- Партиальный unique РУКАМИ (Prisma не выражает WHERE; зеркалится комментом в schema.prisma).
-- Одна ЖИВАЯ сессия правки на документ: WOPI-блокировка в COOL одна на документ, а не на
-- пользователя, и гонка двух первых Lock'ов обязана падать на индексе, а не плодить
-- вторую сессию с чужой lock-строкой.
CREATE UNIQUE INDEX "document_sessions_live" ON "document_sessions"("document_id") WHERE "status" = 'open';

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sessions" ADD CONSTRAINT "document_sessions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
