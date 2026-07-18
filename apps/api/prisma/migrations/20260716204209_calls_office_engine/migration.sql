-- CreateTable
CREATE TABLE "call_sessions" (
    "id" TEXT NOT NULL,
    "room_name" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "started_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_session_participants" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "call_session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "office_rooms" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'meeting',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by_id" TEXT NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "office_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "office_room_participants" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "office_room_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_sessions_room_name_key" ON "call_sessions"("room_name");

-- CreateIndex
CREATE INDEX "call_sessions_ref_type_ref_id_idx" ON "call_sessions"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "call_sessions_status_updated_at_idx" ON "call_sessions"("status", "updated_at");

-- CreateIndex
CREATE INDEX "call_session_participants_session_id_user_id_idx" ON "call_session_participants"("session_id", "user_id");

-- CreateIndex
CREATE INDEX "call_session_participants_session_id_left_at_idx" ON "call_session_participants"("session_id", "left_at");

-- CreateIndex
CREATE INDEX "office_rooms_workspace_id_status_idx" ON "office_rooms"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "office_room_participants_user_id_idx" ON "office_room_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "office_room_participants_room_id_user_id_key" ON "office_room_participants"("room_id", "user_id");

-- AddForeignKey
ALTER TABLE "call_session_participants" ADD CONSTRAINT "call_session_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "office_rooms" ADD CONSTRAINT "office_rooms_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "office_room_participants" ADD CONSTRAINT "office_room_participants_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "office_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ручной partial unique index (Prisma не описывает WHERE-индексы, зеркало — комментарий
-- в schema.prisma у CallSession): одна АКТИВНАЯ сессия на сущность — единственная защита
-- от гонки двух одновременных первых токенов (проигравший create падает P2002 → перечитать).
CREATE UNIQUE INDEX "call_sessions_one_active_per_ref" ON "call_sessions"("ref_type", "ref_id") WHERE status = 'active';
