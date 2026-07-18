-- Звонки в мессенджере: подсистема записи движка core/calls (LiveKit Egress).
-- CallRecording (запись созвона) + CallRecordingClaim («Получить запись») +
-- VoiceRecording.call_recording_id («Журнал звонков» Диктофона).

-- AlterTable
ALTER TABLE "voice_recordings" ADD COLUMN     "call_recording_id" TEXT;

-- CreateTable
CREATE TABLE "call_recordings" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "started_by_id" TEXT NOT NULL,
    "egress_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "file_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_recording_claims" (
    "id" TEXT NOT NULL,
    "recording_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "call_recording_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_recordings_egress_id_key" ON "call_recordings"("egress_id");

-- CreateIndex
CREATE INDEX "call_recordings_session_id_idx" ON "call_recordings"("session_id");

-- CreateIndex
CREATE INDEX "call_recordings_status_updated_at_idx" ON "call_recordings"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "call_recording_claims_recording_id_user_id_key" ON "call_recording_claims"("recording_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_recordings_call_recording_id_owner_id_key" ON "voice_recordings"("call_recording_id", "owner_id");

-- Руками (Prisma не описывает WHERE-индексы): одна АКТИВНАЯ запись на сессию —
-- гонка двух ⏺ гасится P2002 (паттерн call_sessions_one_active_per_ref)
CREATE UNIQUE INDEX "call_recordings_one_active_per_session" ON "call_recordings"("session_id")
    WHERE "status" IN ('recording', 'processing', 'ingesting');

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recording_claims" ADD CONSTRAINT "call_recording_claims_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "call_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
